import type { NetworkManifest } from "@paris-transit/contracts";
import type { Clock, Prediction, RealtimeFeed, RealtimeSource } from "@paris-transit/transit-core";

import { readSiriStream, SiriStreamError, type SiriStreamResult } from "./siri-stream.js";

type JsonRecord = Record<string, unknown>;

/** Line id → normalized terminus name → terminus stop id. */
export type TerminusIndex = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type PrimRealtimeSourceOptions = {
  apiKey: string;
  baseUrl: string;
  /** Provider line ref → manifest line id. Journeys on unmapped lines are skipped. */
  lineIdMap: Readonly<Record<string, string>>;
  /** Provider platform ref → manifest stop id. Calls at unmapped stops are skipped. */
  stopIdMap: Readonly<Record<string, string>>;
  /** Resolves a destination by `DestinationDisplay` when `DestinationRef` is not in the stop map. */
  terminusIndex: TerminusIndex;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  requestTimeoutMs?: number;
  maxCompressedResponseBytes?: number;
  maxDecodedResponseBytes?: number;
};

export class PrimHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfterMs: number | undefined,
    readonly quotaRemaining: number | undefined,
    readonly quotaResetAfterMs: number | undefined = undefined
  ) {
    super(`PRIM returned HTTP ${String(statusCode)}`);
    this.name = "PrimHttpError";
  }
}

export class PrimPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimPayloadError";
  }
}

export class PrimPollThrottledError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`PRIM polling is throttled for ${String(retryAfterMs)}ms`);
    this.name = "PrimPollThrottledError";
  }
}

export class PrimRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`PRIM request exceeded ${String(timeoutMs)}ms`);
    this.name = "PrimRequestTimeoutError";
  }
}

export class PrimResponseTooLargeError extends Error {
  constructor(
    readonly stage: "compressed" | "decoded",
    readonly maximumBytes: number
  ) {
    super(`PRIM ${stage} response exceeded ${String(maximumBytes)} bytes`);
    this.name = "PrimResponseTooLargeError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SIRI-over-JSON wraps most scalars as `{ value }` or `[{ value }]`. */
function unwrapString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    return value.map(unwrapString).find((candidate) => candidate !== undefined);
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["value", "Value", "ref", "Ref"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Reads a field by name, falling back to a case-insensitive match (producers vary). */
function field(record: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    const direct = record[name];
    if (direct !== undefined) return direct;
    const matchingKey = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
    if (matchingKey) return record[matchingKey];
  }
  return undefined;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function timestamp(value: unknown): number | undefined {
  const text = unwrapString(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : time;
}

function normalizedStopName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every pattern terminus of each line, by its direction name and its station name. */
export function buildTerminusIndex(manifest: NetworkManifest): TerminusIndex {
  const stopNames = new Map(manifest.stops.map((stop) => [stop.id, stop.name]));
  return Object.fromEntries(
    manifest.lines.map((line) => {
      const names: Record<string, string> = {};
      for (const direction of line.directions) {
        const terminus = direction.stopIds.at(-1);
        if (!terminus) continue;
        for (const name of [direction.name, stopNames.get(terminus)]) {
          if (name) names[normalizedStopName(name)] = terminus;
        }
      }
      return [line.id, names];
    })
  );
}

function quotaRemaining(headers: Headers): number | undefined {
  for (const name of ["x-ratelimit-remaining", "ratelimit-remaining", "x-quota-remaining"]) {
    const raw = headers.get(name);
    if (raw !== null) {
      const value = Number(raw);
      if (Number.isInteger(value) && value >= 0) return value;
    }
  }
  return undefined;
}

/** PRIM's `ratelimit-reset` is the number of seconds until the daily quota resets. */
function quotaResetAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("ratelimit-reset");
  if (raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function retryAfterMs(value: string | null, now: Date): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = new Date(value).getTime();
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now.getTime()) : undefined;
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be positive`);
  return resolved;
}

/** PRIM refreshes every 120 s; one retry per refresh is allowed when the timestamp has not moved. */
const MINIMUM_REQUEST_INTERVAL_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 30_000;

/**
 * Polls PRIM's SIRI `estimated-timetable` endpoint and turns it into platform countdowns.
 *
 * PRIM accepts at most one line filter, so the whole Île-de-France network is fetched in one
 * request (about 140 MB decoded) and streamed; only journeys on mapped Métro lines are kept.
 * PRIM journey ids are not stable train identities, so every call is emitted as an independent
 * "a train reaches platform P in t seconds" prediction and identity is rebuilt by the tracker.
 */
export class PrimRealtimeSource implements RealtimeSource {
  readonly kind = "prim" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly requestTimeoutMs: number;
  private readonly maxCompressedResponseBytes: number;
  private readonly maxDecodedResponseBytes: number;
  private lastAttemptAt: number | undefined;

  constructor(private readonly options: PrimRealtimeSourceOptions) {
    if (!options.apiKey) throw new Error("PRIM_API_KEY is required when TRANSIT_SOURCE=prim");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
    this.requestTimeoutMs = positiveOption(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.maxCompressedResponseBytes = positiveOption(
      options.maxCompressedResponseBytes,
      32 * 1024 * 1024,
      "maxCompressedResponseBytes"
    );
    this.maxDecodedResponseBytes = positiveOption(
      options.maxDecodedResponseBytes,
      128 * 1024 * 1024,
      "maxDecodedResponseBytes"
    );
  }

  async poll(signal?: AbortSignal): Promise<RealtimeFeed> {
    // A hard floor between requests protects the daily quota even if a caller misbehaves.
    const attemptStartedAt = this.clock();
    if (this.lastAttemptAt !== undefined) {
      const elapsed = attemptStartedAt.getTime() - this.lastAttemptAt;
      if (elapsed < MINIMUM_REQUEST_INTERVAL_MS) {
        throw new PrimPollThrottledError(Math.max(0, MINIMUM_REQUEST_INTERVAL_MS - elapsed));
      }
    }
    this.lastAttemptAt = attemptStartedAt.getTime();

    const baseUrl = this.options.baseUrl.endsWith("/")
      ? this.options.baseUrl
      : `${this.options.baseUrl}/`;
    const controller = new AbortController();
    const timeoutError = new PrimRequestTimeoutError(this.requestTimeoutMs);
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
    }, this.requestTimeoutMs);
    let response: Response;
    let parsed: SiriStreamResult<Prediction[]>;
    let remaining: number | undefined;
    try {
      response = await this.fetchImpl(new URL("estimated-timetable", baseUrl), {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          apikey: this.options.apiKey
        },
        signal: controller.signal
      });
      remaining = quotaRemaining(response.headers);
      if (!response.ok) {
        throw new PrimHttpError(
          response.status,
          retryAfterMs(response.headers.get("retry-after"), this.clock()),
          remaining,
          quotaResetAfterMs(response.headers)
        );
      }
      const compressedLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(compressedLength) && compressedLength > this.maxCompressedResponseBytes) {
        throw new PrimResponseTooLargeError("compressed", this.maxCompressedResponseBytes);
      }
      if (!response.body) throw new PrimPayloadError("PRIM response is not valid JSON");
      parsed = await readSiriStream(response.body, this.maxDecodedResponseBytes, (journey) =>
        this.journeyPredictions(journey)
      );
    } catch (error) {
      if (controller.signal.reason === timeoutError) throw timeoutError;
      if (error instanceof SiriStreamError) {
        throw error.reason === "too_large"
          ? new PrimResponseTooLargeError("decoded", this.maxDecodedResponseBytes)
          : new PrimPayloadError("PRIM response is not valid JSON");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
    const receivedAt = this.clock();
    if (!parsed.hasSiri) throw new PrimPayloadError("PRIM response is not a SIRI payload");
    const feedAt = parsed.responseTimestamps.map(timestamp).find((value) => value !== undefined);
    if (feedAt === undefined) throw new PrimPayloadError("PRIM response has no valid timestamp");
    if (feedAt > receivedAt.getTime() + MAX_CLOCK_SKEW_MS) {
      throw new PrimPayloadError("PRIM response timestamp is implausibly in the future");
    }

    const result: RealtimeFeed = {
      source: "prim",
      feedAt,
      receivedAt: receivedAt.getTime(),
      predictions: parsed.journeys.flat()
    };
    if (remaining !== undefined) result.quotaRemaining = remaining;
    const resetAfterMs = quotaResetAfterMs(response.headers);
    if (resetAfterMs !== undefined) result.quotaResetAfterMs = resetAfterMs;
    const retryAfter = retryAfterMs(response.headers.get("retry-after"), receivedAt);
    if (retryAfter !== undefined) result.retryAfterMs = retryAfter;
    return result;
  }

  /**
   * One SIRI `EstimatedVehicleJourney` → one countdown per call with a realtime time at a mapped
   * platform. The destination (which picks the branch) comes from `DestinationRef`, or else from the
   * displayed destination name matched against the line's termini.
   */
  private journeyPredictions(value: unknown): Prediction[] | undefined {
    if (!isRecord(value)) return undefined;
    const lineId = this.options.lineIdMap[unwrapString(field(value, "LineRef")) ?? ""];
    if (!lineId) return undefined;
    const destinationRef = unwrapString(field(value, "DestinationRef"));
    const mappedDestination = destinationRef ? this.options.stopIdMap[destinationRef] : undefined;
    const destinationName =
      unwrapString(field(value, "DestinationName", "DestinationRef")) ?? "Unknown destination";
    const terminusByName = this.options.terminusIndex[lineId] ?? {};
    const calls = field(value, "EstimatedCalls");
    const callValues = isRecord(calls)
      ? asList(field(calls, "EstimatedCall", "EstimatedCalls"))
      : asList(calls);

    const predictions = callValues.flatMap((call): Prediction[] => {
      if (!isRecord(call)) return [];
      const stopId = this.options.stopIdMap[unwrapString(field(call, "StopPointRef")) ?? ""];
      // Aimed (timetabled) times carry no position information, so only expected times count.
      const expectedAt =
        timestamp(field(call, "ExpectedArrivalTime")) ??
        timestamp(field(call, "ExpectedDepartureTime"));
      const displayed = unwrapString(field(call, "DestinationDisplay")) ?? destinationName;
      const destinationStopId = mappedDestination ?? terminusByName[normalizedStopName(displayed)];
      if (!stopId || expectedAt === undefined || !destinationStopId) return [];
      // The free-text CallNote is the only direct position evidence PRIM gives for the Métro.
      const note = (unwrapString(field(call, "CallNote")) ?? "").toLowerCase();
      return [
        {
          lineId,
          stopId,
          destinationStopId,
          expectedAt,
          ...(note.includes("à quai") || note.includes("a quai")
            ? { note: "at_platform" as const }
            : note.includes("approche")
              ? { note: "approaching" as const }
              : {})
        }
      ];
    });
    return predictions.length > 0 ? predictions : undefined;
  }
}
