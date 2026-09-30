import {
  schemaVersion,
  trainSnapshotSchemaVersion,
  type NetworkManifest,
  type ServiceStatus,
  type TrainSnapshot
} from "@paris-transit/contracts";
import {
  placementParameters,
  TrainTracker,
  type PatternTimeline,
  type RealtimeFeed,
  type RealtimeSource,
  type TrackerSnapshot
} from "@paris-transit/transit-core";

import { trainLineIds } from "./network-data.js";
import { inNightPause, millisecondsUntilPauseEnds } from "./service-hours.js";
import { PrimHttpError } from "./sources/prim-source.js";
import type { LiveStore } from "./store.js";

/** PRIM publishes a new estimated timetable every 120 s; polling is phase-locked to it. */
export const providerRefreshMs = 120_000;
/** A refresh is published 24–37 s after its timestamp; polling earlier returns the previous one and
 * costs a second request. */
const POLL_AFTER_REFRESH_MS = 45_000;
const UNCHANGED_RETRY_MS = 30_000;
const BACKOFF_BASE_MS = 90_000;
const MAX_BACKOFF_MS = 600_000;
const PRIM_QUOTA_RESERVE = 10;
const QUOTA_FALLBACK_MS = 24 * 60 * 60 * 1000;
const QUOTA_RESET_MARGIN_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const FEED_STALE_MS = placementParameters.feedFreezeAfterSeconds * 1000;
const UNAVAILABLE_AFTER_MS = 600_000;
// setTimeout's longest delay; longer waits are chained.
const MAX_TIMER_MS = 2_147_483_647;

type IngestionLogger = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
};

class IngestionRejectedError extends Error {
  constructor(readonly category: string) {
    super(`Realtime update rejected: ${category}`);
    this.name = "IngestionRejectedError";
  }
}

/** Rejects feeds from the wrong source, with impossible timestamps, or with bad quota metadata. */
function validateFeed(feed: RealtimeFeed, source: RealtimeSource, now: Date): void {
  if (feed.source !== source.kind) throw new IngestionRejectedError("source_mismatch");
  if (!Number.isFinite(feed.feedAt) || !Number.isFinite(feed.receivedAt)) {
    throw new IngestionRejectedError("invalid_timestamp");
  }
  if (
    feed.feedAt > feed.receivedAt + MAX_CLOCK_SKEW_MS ||
    feed.receivedAt > now.getTime() + MAX_CLOCK_SKEW_MS
  ) {
    throw new IngestionRejectedError("future_timestamp");
  }
  if (
    (feed.quotaRemaining !== undefined &&
      (!Number.isInteger(feed.quotaRemaining) || feed.quotaRemaining < 0)) ||
    (feed.retryAfterMs !== undefined &&
      (!Number.isFinite(feed.retryAfterMs) || feed.retryAfterMs < 0)) ||
    (feed.quotaResetAfterMs !== undefined &&
      (!Number.isFinite(feed.quotaResetAfterMs) || feed.quotaResetAfterMs < 0))
  ) {
    throw new IngestionRejectedError("invalid_provider_metadata");
  }
}

function toTrainSnapshot(
  snapshot: TrackerSnapshot,
  topologyVersion: string,
  generatedAt: Date
): Omit<TrainSnapshot, "sequence"> {
  const iso = (value: number) => new Date(value).toISOString();
  return {
    schemaVersion: trainSnapshotSchemaVersion,
    topologyVersion,
    feedAt: snapshot.feedAt === null ? null : iso(snapshot.feedAt),
    generatedAt: generatedAt.toISOString(),
    lines: snapshot.lines.map((line) => ({
      lineId: line.lineId,
      state: line.state,
      ...(line.since === undefined ? {} : { since: iso(line.since) })
    })),
    trains: snapshot.trains.map((train) => ({
      id: train.id,
      lineId: train.lineId,
      patternId: train.patternId,
      destinationName: train.destinationName,
      virtualStartAt: iso(train.virtualStartAt),
      ...(train.holdStopIndex === undefined ? {} : { holdStopIndex: train.holdStopIndex }),
      lastEvidenceAt: iso(train.lastEvidenceAt),
      state: train.state,
      stateSince: iso(train.stateSince)
    }))
  };
}

/** The next poll: 45 s after an expected provider refresh, and at least 30 s from now. */
export function nextRefreshPollDelay(feedAt: number, now: number): number {
  let target = feedAt + providerRefreshMs + POLL_AFTER_REFRESH_MS;
  while (target - now < UNCHANGED_RETRY_MS) target += providerRefreshMs;
  return target - now;
}

/** Resumes one minute after the quota reset PRIM reports; without one, waits at least a day. A
 * longer provider Retry-After wins. */
function quotaPauseMs(providerRetryAfterMs = 0, quotaResetAfterMs?: number): number {
  const pauseMs =
    quotaResetAfterMs === undefined ? QUOTA_FALLBACK_MS : quotaResetAfterMs + QUOTA_RESET_MARGIN_MS;
  return Math.max(pauseMs, providerRetryAfterMs);
}

function failureCategory(error: unknown): string {
  if (error instanceof IngestionRejectedError) return error.category;
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

function status(
  source: RealtimeSource,
  now: Date,
  feedAt: number | undefined,
  fields: Pick<ServiceStatus, "status" | "supportedLines" | "message">
): ServiceStatus {
  return {
    schemaVersion,
    source: source.kind,
    generatedAt: now.toISOString(),
    sourceObservedAt: feedAt === undefined ? null : new Date(feedAt).toISOString(),
    sourceAgeSeconds: feedAt === undefined ? null : Math.max(0, (now.getTime() - feedAt) / 1000),
    pollIntervalSeconds: providerRefreshMs / 1000,
    ...fields
  };
}

/**
 * Polls the realtime source, feeds the train tracker, and publishes snapshots and service status to
 * the store. Polls follow PRIM's refresh cycle. Failures freeze every line and back off
 * exponentially from 90 s to 10 min, and polling pauses near the daily quota and overnight.
 */
export class IngestionLoop {
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private consecutiveFailures = 0;
  private lastFeedAt: number | undefined;
  private retriedUnchanged = false;
  private readonly tracker: TrainTracker;
  private readonly clock: () => Date;
  private readonly logger: IngestionLogger | undefined;

  constructor(
    private readonly source: RealtimeSource,
    private readonly store: LiveStore,
    private readonly manifest: NetworkManifest,
    timelines: readonly PatternTimeline[],
    options: { clock?: () => Date; logger?: IngestionLogger } = {}
  ) {
    this.tracker = new TrainTracker(timelines, trainLineIds(manifest));
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const timerDelayMs = Math.min(delayMs, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (delayMs > MAX_TIMER_MS) this.schedule(delayMs - MAX_TIMER_MS);
      else void this.run();
    }, timerDelayMs);
  }

  private async publish(now: Date): Promise<TrainSnapshot["lines"]> {
    const snapshot = toTrainSnapshot(
      this.tracker.snapshot(now.getTime()),
      this.manifest.topologyVersion,
      now
    );
    await this.store.setSnapshot(snapshot);
    return snapshot.lines;
  }

  private async run(): Promise<void> {
    const attemptedAt = this.clock();
    if (this.source.kind === "prim" && inNightPause(attemptedAt)) {
      const previous = await this.store.getStatus();
      await this.store.setStatus(
        status(this.source, attemptedAt, this.lastFeedAt, {
          status: "no_service",
          supportedLines: previous?.supportedLines ?? 0,
          message: "No Métro service at this hour"
        })
      );
      this.logger?.info({ event: "prim_night_pause" }, "PRIM polling paused overnight");
      this.schedule(millisecondsUntilPauseEnds(attemptedAt));
      return;
    }

    this.controller = new AbortController();
    try {
      const feed = await this.source.poll(this.controller.signal);
      if (this.stopped) return;
      const now = this.clock();
      validateFeed(feed, this.source, now);
      if (this.lastFeedAt !== undefined && feed.feedAt <= this.lastFeedAt) {
        await this.handleUnchanged(now);
      } else {
        await this.accept(feed, now, attemptedAt);
      }
    } catch (error) {
      if (this.stopped && this.controller.signal.aborted) return;
      await this.handleFailure(error, attemptedAt);
    }
  }

  private async accept(feed: RealtimeFeed, now: Date, attemptedAt: Date): Promise<void> {
    this.tracker.refresh(feed, now.getTime());
    this.lastFeedAt = feed.feedAt;
    this.retriedUnchanged = false;
    const recovered = this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    const lines = await this.publish(now);
    const frozen = lines.filter((line) => line.state === "frozen").length;
    const previous = await this.store.getStatus();
    const quotaLimited =
      feed.quotaRemaining !== undefined && feed.quotaRemaining <= PRIM_QUOTA_RESERVE;
    const nextPollDelayMs = quotaLimited
      ? quotaPauseMs(feed.retryAfterMs, feed.quotaResetAfterMs)
      : nextRefreshPollDelay(feed.feedAt, now.getTime());
    await this.store.setStatus(
      status(this.source, now, feed.feedAt, {
        status: quotaLimited || frozen > 0 ? "degraded" : "healthy",
        supportedLines: lines.length - frozen,
        message: quotaLimited
          ? "PRIM quota reserve reached; polling paused"
          : frozen > 0
            ? "Live data is paused on some lines"
            : recovered || (previous !== undefined && previous.status !== "healthy")
              ? "Realtime source recovered"
              : "Realtime source is fresh"
      })
    );
    this.logger?.info(
      {
        event: quotaLimited ? "prim_quota_paused" : "realtime_poll_accepted",
        attemptedAt: attemptedAt.toISOString(),
        feedAt: new Date(feed.feedAt).toISOString(),
        predictions: feed.predictions.length,
        frozenLines: frozen,
        nextPollDelayMs,
        ...(feed.quotaRemaining === undefined ? {} : { quotaRemaining: feed.quotaRemaining })
      },
      quotaLimited ? "PRIM polling paused at quota reserve" : "Realtime poll accepted"
    );
    this.schedule(nextPollDelayMs);
  }

  /** Not a failure: retry once after 30 s, then wait for the next refresh. A feed older than five
   * minutes freezes every line. */
  private async handleUnchanged(now: Date): Promise<void> {
    const lastFeedAt = this.lastFeedAt ?? now.getTime();
    const stale = now.getTime() - lastFeedAt > FEED_STALE_MS;
    if (stale) {
      this.tracker.freezeAll(now.getTime());
      await this.publish(now);
      const previous = await this.store.getStatus();
      await this.store.setStatus(
        status(this.source, now, lastFeedAt, {
          status: "degraded",
          supportedLines: previous?.supportedLines ?? 0,
          message: "Realtime source is stale; live data paused"
        })
      );
    }
    const nextRefresh = this.retriedUnchanged
      ? nextRefreshPollDelay(lastFeedAt, now.getTime())
      : UNCHANGED_RETRY_MS;
    // Poll again right as the feed turns stale, but never sooner than the provider's minimum
    // request interval: an earlier poll would be throttled and counted as a failure.
    const untilStale = lastFeedAt + FEED_STALE_MS + 1 - now.getTime();
    const nextPollDelayMs = stale
      ? nextRefresh
      : Math.max(UNCHANGED_RETRY_MS, Math.min(nextRefresh, untilStale));
    this.retriedUnchanged = true;
    this.logger?.info(
      {
        event: "realtime_feed_unchanged",
        feedAt: new Date(lastFeedAt).toISOString(),
        stale,
        nextPollDelayMs
      },
      "Realtime feed has not advanced"
    );
    this.schedule(nextPollDelayMs);
  }

  private async handleFailure(error: unknown, attemptedAt: Date): Promise<void> {
    this.consecutiveFailures += 1;
    const now = this.clock();
    this.tracker.freezeAll(now.getTime());
    await this.publish(now);
    const previous = await this.store.getStatus();
    const recent =
      this.lastFeedAt !== undefined && now.getTime() - this.lastFeedAt <= UNAVAILABLE_AFTER_MS;
    await this.store.setStatus(
      status(this.source, now, this.lastFeedAt, {
        status: recent && (previous?.supportedLines ?? 0) > 0 ? "degraded" : "unavailable",
        supportedLines: previous?.supportedLines ?? 0,
        message: recent
          ? "Realtime source is reconnecting; live data paused"
          : "Realtime source is unavailable"
      })
    );

    const providerRetryAfterMs = error instanceof PrimHttpError ? (error.retryAfterMs ?? 0) : 0;
    const quotaRemaining = error instanceof PrimHttpError ? error.quotaRemaining : undefined;
    const quotaLimited = quotaRemaining !== undefined && quotaRemaining <= PRIM_QUOTA_RESERVE;
    const nextPollDelayMs = quotaLimited
      ? quotaPauseMs(
          providerRetryAfterMs,
          error instanceof PrimHttpError ? error.quotaResetAfterMs : undefined
        )
      : Math.max(
          Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1)),
          providerRetryAfterMs
        );
    this.logger?.warn(
      {
        event: quotaLimited ? "prim_quota_paused" : "realtime_poll_failed",
        attemptedAt: attemptedAt.toISOString(),
        failureCategory: failureCategory(error),
        feedAt: this.lastFeedAt === undefined ? null : new Date(this.lastFeedAt).toISOString(),
        consecutiveFailures: this.consecutiveFailures,
        nextPollDelayMs,
        ...(quotaRemaining === undefined ? {} : { quotaRemaining }),
        ...(error instanceof PrimHttpError ? { httpStatus: error.statusCode } : {})
      },
      quotaLimited ? "PRIM polling paused at quota reserve" : "Realtime poll failed"
    );
    this.schedule(nextPollDelayMs);
  }
}
