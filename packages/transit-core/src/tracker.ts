/**
 * Keeps train identity across provider refreshes. On each refresh, a line's countdowns become
 * clusters (estimator.ts). The clusters are matched in order to the existing trains on each
 * pattern. Unmatched trains coast to their next stop, well-supported unmatched clusters become new
 * trains, and no two trains may sit within G of each other on one track.
 */

import { mergedCoastingTrainIds } from "./display.js";
import {
  clusterProjections,
  indexPatterns,
  placementParameters,
  pointsConflict,
  projectPredictions,
  trackPoints,
  usablePredictions,
  type Cluster,
  type IndexedPattern,
  type PatternNetwork,
  type TrackPoint
} from "./estimator.js";
import { positionAt, timelineSeconds, type PatternTimeline, type TrainState } from "./timeline.js";
import type { Prediction, RealtimeFeed } from "./types.js";

/** Times are epoch milliseconds. */
export type TrackedTrain = {
  id: string;
  lineId: string;
  patternId: string;
  destinationName: string;
  virtualStartAt: number;
  holdStopIndex?: number | undefined;
  lastEvidenceAt: number;
  state: TrainState;
  stateSince: number;
};

export type LineStatus = {
  lineId: string;
  state: "live" | "frozen";
  since?: number | undefined;
};

export type TrackerSnapshot = {
  feedAt: number | null;
  lines: LineStatus[];
  trains: TrackedTrain[];
};

type Train = TrackedTrain & { birth: number; support: number };

type Candidate = {
  train: Train;
  points: TrackPoint[];
  isBirth: boolean;
  inherited: boolean;
};

/** FNV-1a, for short deterministic train ids. */
function hash(value: string): string {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36);
}

type Match = { train: number; cluster: number };

/** Order-preserving alignment: most matches first, then the smallest total τ0 difference. */
function alignInOrder(
  trains: readonly Train[],
  clusters: readonly Cluster[],
  toleranceSeconds: number,
  eligible: (train: Train) => boolean
): Match[] {
  const rows = trains.length + 1;
  const columns = clusters.length + 1;
  const matches = new Array<number>(rows * columns).fill(0);
  const costs = new Array<number>(rows * columns).fill(0);
  const cell = (row: number, column: number) => row * columns + column;
  const better = (count: number, cost: number, index: number) =>
    count > (matches[index] ?? 0) ||
    (count === (matches[index] ?? 0) && cost < (costs[index] ?? 0));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const index = cell(row, column);
      const up = cell(row - 1, column);
      const left = cell(row, column - 1);
      const [fromCount, fromCost] =
        (matches[up] ?? 0) > (matches[left] ?? 0) ||
        ((matches[up] ?? 0) === (matches[left] ?? 0) && (costs[up] ?? 0) <= (costs[left] ?? 0))
          ? [matches[up] ?? 0, costs[up] ?? 0]
          : [matches[left] ?? 0, costs[left] ?? 0];
      matches[index] = fromCount;
      costs[index] = fromCost;
      const train = trains[row - 1];
      const cluster = clusters[column - 1];
      if (!train || !cluster || !eligible(train)) continue;
      const difference = Math.abs(train.virtualStartAt - cluster.virtualStartAt) / 1000;
      if (difference > toleranceSeconds) continue;
      const diagonal = cell(row - 1, column - 1);
      const count = (matches[diagonal] ?? 0) + 1;
      const cost = (costs[diagonal] ?? 0) + difference;
      if (better(count, cost, index)) {
        matches[index] = count;
        costs[index] = cost;
      }
    }
  }
  const result: Match[] = [];
  let row = trains.length;
  let column = clusters.length;
  while (row > 0 && column > 0) {
    const index = cell(row, column);
    const up = cell(row - 1, column);
    const diagonal = cell(row - 1, column - 1);
    const train = trains[row - 1];
    const cluster = clusters[column - 1];
    const difference =
      train && cluster ? Math.abs(train.virtualStartAt - cluster.virtualStartAt) / 1000 : Infinity;
    if (
      train &&
      cluster &&
      eligible(train) &&
      difference <= toleranceSeconds &&
      matches[index] === (matches[diagonal] ?? 0) + 1 &&
      Math.abs((costs[index] ?? 0) - ((costs[diagonal] ?? 0) + difference)) < 1e-9
    ) {
      result.push({ train: row - 1, cluster: column - 1 });
      row -= 1;
      column -= 1;
    } else if (matches[index] === matches[up] && costs[index] === costs[up]) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return result.reverse();
}

/** Matches within the normal tolerance, then fills the gaps with coasting trains at a wider one. */
function matchPattern(trains: readonly Train[], clusters: readonly Cluster[]): Match[] {
  const first = alignInOrder(
    trains,
    clusters,
    placementParameters.matchToleranceSeconds,
    () => true
  );
  const matches = [...first];
  const anchors = [
    { train: -1, cluster: -1 },
    ...first,
    { train: trains.length, cluster: clusters.length }
  ];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const start = anchors[index];
    const end = anchors[index + 1];
    if (!start || !end) continue;
    const gapTrains = trains.slice(start.train + 1, end.train);
    const gapClusters = clusters.slice(start.cluster + 1, end.cluster);
    if (gapTrains.length === 0 || gapClusters.length === 0) continue;
    for (const match of alignInOrder(
      gapTrains,
      gapClusters,
      placementParameters.coastingMatchToleranceSeconds,
      (train) => train.holdStopIndex !== undefined
    )) {
      matches.push({
        train: start.train + 1 + match.train,
        cluster: start.cluster + 1 + match.cluster
      });
    }
  }
  return matches;
}

/** The stop a coasting train waits at: the one it is at, or the next one ahead. */
function holdStopIndex(timeline: PatternTimeline, x: number): number {
  const position = positionAt(timeline, x);
  switch (position.kind) {
    case "moving":
      return position.segmentIndex + 1;
    case "docked":
    case "terminus":
      return position.stopIndex;
    case "not_started":
      return 1;
  }
}

function byTrack(left: TrackedTrain, right: TrackedTrain): number {
  return (
    left.lineId.localeCompare(right.lineId) ||
    left.patternId.localeCompare(right.patternId) ||
    left.virtualStartAt - right.virtualStartAt ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Keeps train identity across provider refreshes. All state changes are driven by the feed and the
 * `now` values passed in, so identical inputs always produce identical snapshots.
 */
export class TrainTracker {
  private readonly network: PatternNetwork;
  private readonly lineIds: readonly string[];
  private readonly lineStates = new Map<string, LineStatus>();
  private trains: Train[] = [];
  private feedAt: number | null = null;
  private births = 0;

  constructor(timelines: readonly PatternTimeline[], lineIds: readonly string[]) {
    const eligible = new Set(lineIds);
    this.network = indexPatterns(timelines.filter((timeline) => eligible.has(timeline.lineId)));
    this.lineIds = lineIds.filter((lineId) => this.network.lines.has(lineId));
  }

  /**
   * Applies one provider refresh. A stale feed freezes every line. A line with no predictions
   * freezes if it had at least `lineFreezeMinimumTrains` trains.
   */
  refresh(feed: RealtimeFeed, now: number): void {
    if (now - feed.feedAt > placementParameters.feedFreezeAfterSeconds * 1000) {
      this.freezeAll(now);
      return;
    }
    this.feedAt = feed.feedAt;
    const byLine = new Map<string, Prediction[]>();
    for (const prediction of usablePredictions(feed.predictions, feed.feedAt)) {
      byLine.set(prediction.lineId, [...(byLine.get(prediction.lineId) ?? []), prediction]);
    }
    for (const lineId of this.lineIds) {
      const predictions = byLine.get(lineId) ?? [];
      const lineTrains = this.trains.filter((train) => train.lineId === lineId);
      const frozen = this.lineStates.get(lineId)?.state === "frozen";
      if (
        predictions.length === 0 &&
        (frozen || lineTrains.length >= placementParameters.lineFreezeMinimumTrains)
      ) {
        this.freezeLine(lineId, now);
        continue;
      }
      if (frozen) this.lineStates.set(lineId, { lineId, state: "live", since: now });
      this.trains = [
        ...this.trains.filter((train) => train.lineId !== lineId),
        ...this.updateLine(lineId, lineTrains, predictions, feed.feedAt, now)
      ];
    }
    this.prune(now);
  }

  freezeAll(now: number): void {
    for (const lineId of this.lineIds) this.freezeLine(lineId, now);
    this.prune(now);
  }

  snapshot(now: number): TrackerSnapshot {
    this.prune(now);
    return {
      feedAt: this.feedAt,
      lines: this.lineIds.map((lineId) => this.lineStates.get(lineId) ?? { lineId, state: "live" }),
      trains: this.trains
        .map((train) => ({
          id: train.id,
          lineId: train.lineId,
          patternId: train.patternId,
          destinationName: train.destinationName,
          virtualStartAt: train.virtualStartAt,
          ...(train.holdStopIndex === undefined ? {} : { holdStopIndex: train.holdStopIndex }),
          lastEvidenceAt: train.lastEvidenceAt,
          state: train.state,
          stateSince: train.stateSince
        }))
        .sort(byTrack)
    };
  }

  private freezeLine(lineId: string, now: number) {
    if (this.lineStates.get(lineId)?.state === "frozen") return;
    this.lineStates.set(lineId, { lineId, state: "frozen", since: now });
    this.trains = this.trains.map((train) =>
      train.lineId === lineId ? { ...train, state: "frozen", stateSince: now } : train
    );
  }

  private pattern(patternId: string): IndexedPattern | undefined {
    return this.network.patterns.get(patternId);
  }

  private updateLine(
    lineId: string,
    trains: readonly Train[],
    predictions: readonly Prediction[],
    feedAt: number,
    now: number
  ): Train[] {
    const clusters = clusterProjections(
      projectPredictions(predictions, this.network, feedAt),
      this.network,
      feedAt
    );
    const matched = new Map<Train, Cluster>();
    const unmatchedClusters = new Set(clusters);
    for (const pattern of this.network.lines.get(lineId) ?? []) {
      const patternTrains = trains
        .filter((train) => train.patternId === pattern.timeline.id)
        .sort(byTrack);
      const patternClusters = clusters.filter(
        (cluster) => cluster.patternId === pattern.timeline.id
      );
      for (const match of matchPattern(patternTrains, patternClusters)) {
        const train = patternTrains[match.train];
        const cluster = patternClusters[match.cluster];
        if (!train || !cluster) continue;
        matched.set(train, cluster);
        unmatchedClusters.delete(cluster);
      }
    }

    const existing: Train[] = [];
    for (const train of trains) {
      const cluster = matched.get(train);
      const timeline = this.pattern(train.patternId)?.timeline;
      if (!timeline) continue;
      if (cluster) {
        existing.push({
          ...train,
          virtualStartAt: cluster.virtualStartAt,
          holdStopIndex: undefined,
          lastEvidenceAt: feedAt,
          support: cluster.support,
          state: "live",
          stateSince: train.state === "live" ? train.stateSince : now
        });
      } else if (train.state === "live") {
        existing.push({
          ...train,
          holdStopIndex: holdStopIndex(timeline, timelineSeconds(train, timeline, now)),
          state: "coasting",
          stateSince: now
        });
      } else if (train.state === "coasting") {
        existing.push(train);
      }
    }

    const births = [...unmatchedClusters]
      .filter((cluster) => cluster.support >= placementParameters.birthSupport || cluster.hasNote)
      .map(
        (cluster): Train => ({
          id: `t${hash(`${cluster.patternId}|${String(feedAt)}|${String(cluster.virtualStartAt)}`)}`,
          lineId,
          patternId: cluster.patternId,
          destinationName: this.pattern(cluster.patternId)?.timeline.name ?? "",
          virtualStartAt: cluster.virtualStartAt,
          lastEvidenceAt: feedAt,
          state: "live",
          stateSince: now,
          birth: Infinity,
          support: cluster.support
        })
      );
    return this.exclude(existing, births, feedAt);
  }

  /** No two trains within G of each other on one track: more support wins, then the older train.
   * A coasting train that conflicts with a live one is merged into it. */
  private exclude(existing: readonly Train[], births: readonly Train[], feedAt: number): Train[] {
    const candidate = (train: Train, isBirth: boolean): Candidate => {
      const timeline = this.pattern(train.patternId)?.timeline;
      const x = timeline ? timelineSeconds(train, timeline, feedAt) : -1;
      return {
        train,
        points: trackPoints(train.patternId, x, this.network),
        isBirth,
        inherited: false
      };
    };
    const priority = (left: Candidate, right: Candidate) =>
      right.train.support - left.train.support ||
      left.train.birth - right.train.birth ||
      left.train.virtualStartAt - right.train.virtualStartAt ||
      left.train.patternId.localeCompare(right.train.patternId);
    const live = [
      ...existing.filter((train) => train.state === "live").map((train) => candidate(train, false)),
      ...births.map((train) => candidate(train, true))
    ].sort(priority);
    const coasting = existing
      .filter((train) => train.state === "coasting")
      .map((train) => candidate(train, false))
      .sort(priority);

    const accepted: Candidate[] = [];
    for (const item of live) {
      if (accepted.some((other) => pointsConflict(item.points, other.points))) continue;
      accepted.push(item);
    }
    for (const item of coasting) {
      const conflicts = accepted.filter((other) => pointsConflict(item.points, other.points));
      if (conflicts.length === 0) {
        accepted.push(item);
        continue;
      }
      const heir = conflicts.find(
        (other) =>
          other.isBirth && !other.inherited && other.train.patternId === item.train.patternId
      );
      if (heir) {
        heir.train = { ...heir.train, id: item.train.id, birth: item.train.birth };
        heir.inherited = true;
      }
    }

    return accepted.map((item) => {
      if (!item.isBirth || item.inherited) return item.train;
      const birth = this.births;
      this.births += 1;
      return { ...item.train, birth };
    });
  }

  /**
   * Drops merged coasting trains, lines frozen past the cap, coasting trains past the timeout, and
   * trains past their terminus.
   */
  private prune(now: number) {
    const merged = mergedCoastingTrainIds(this.trains, this.network, now);
    this.trains = this.trains.filter((train) => !merged.has(train.id));
    for (const status of this.lineStates.values()) {
      if (
        status.state === "frozen" &&
        status.since !== undefined &&
        now - status.since >= placementParameters.freezeCapSeconds * 1000
      ) {
        this.trains = this.trains.filter((train) => train.lineId !== status.lineId);
      }
    }
    this.trains = this.trains.filter((train) => {
      if (train.state === "frozen") return true;
      if (
        train.state === "coasting" &&
        now - train.lastEvidenceAt >= placementParameters.coastingTimeoutSeconds * 1000
      ) {
        return false;
      }
      const timeline = this.pattern(train.patternId)?.timeline;
      if (!timeline) return false;
      const last = timeline.stopIds.length - 1;
      const x =
        train.holdStopIndex === last
          ? (now - train.virtualStartAt) / 1000
          : timelineSeconds(train, timeline, now);
      return x < (timeline.arr[last] ?? 0) + placementParameters.terminusRemovalSeconds;
    });
  }
}
