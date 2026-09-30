/**
 * Turns platform countdowns into train estimates. Each usable prediction is projected onto every
 * pattern that can carry it, which gives a τ0 (see timeline.ts). Projections on one pattern whose
 * τ0 values are closer than G (`sameTrainGapSeconds`) are clustered into one train.
 */

import { positionAt, type PatternTimeline } from "./timeline.js";
import type { Prediction } from "./types.js";

/** Values from the train placement specification (docs/train-placement.md). */
export const placementParameters = {
  predictionWindowBeforeSeconds: 60,
  predictionWindowAfterSeconds: 600,
  duplicateSeconds: 5,
  sameTrainGapSeconds: 45,
  bestMemberMinimumCountdownSeconds: -30,
  matchToleranceSeconds: 120,
  coastingMatchToleranceSeconds: 240,
  birthSupport: 2,
  coastingTimeoutSeconds: 300,
  terminusRemovalSeconds: 60,
  lineFreezeMinimumTrains: 3,
  feedFreezeAfterSeconds: 300,
  freezeCapSeconds: 3 * 60 * 60
} as const;

/** A timeline with lookups from a stop, or a stop-to-stop edge, to its indexes. */
export type IndexedPattern = {
  timeline: PatternTimeline;
  stopIndexes: ReadonlyMap<string, readonly number[]>;
  segmentIndexes: ReadonlyMap<string, readonly number[]>;
};

export type PatternNetwork = {
  patterns: ReadonlyMap<string, IndexedPattern>;
  lines: ReadonlyMap<string, readonly IndexedPattern[]>;
};

/** One prediction placed on one pattern. */
export type Projection = {
  patternId: string;
  stopIndex: number;
  /** τ0 implied by arrival at the stop, in epoch milliseconds. */
  virtualStartAt: number;
  prediction: Prediction;
};

/** Predictions on one pattern that describe the same train. */
export type Cluster = {
  lineId: string;
  patternId: string;
  virtualStartAt: number;
  support: number;
  hasNote: boolean;
};

/** A point on one pattern's timeline, in seconds after its origin departure. */
export type TrackPoint = { patternId: string; x: number };

function edgeKey(fromStopId: string, toStopId: string): string {
  return `${fromStopId}|${toStopId}`;
}

function pushIndex(map: Map<string, number[]>, key: string, index: number) {
  const indexes = map.get(key) ?? [];
  indexes.push(index);
  map.set(key, indexes);
}

export function indexPatterns(timelines: readonly PatternTimeline[]): PatternNetwork {
  const patterns = new Map<string, IndexedPattern>();
  const lines = new Map<string, IndexedPattern[]>();
  for (const timeline of timelines) {
    const stopIndexes = new Map<string, number[]>();
    const segmentIndexes = new Map<string, number[]>();
    timeline.stopIds.forEach((stopId, index) => {
      pushIndex(stopIndexes, stopId, index);
      const next = timeline.stopIds[index + 1];
      if (next !== undefined) pushIndex(segmentIndexes, edgeKey(stopId, next), index);
    });
    const pattern = { timeline, stopIndexes, segmentIndexes };
    patterns.set(timeline.id, pattern);
    lines.set(timeline.lineId, [...(lines.get(timeline.lineId) ?? []), pattern]);
  }
  return { patterns, lines };
}

const noteRank = { at_platform: 2, approaching: 1 } as const;

function rankOf(prediction: Prediction): number {
  return prediction.note ? noteRank[prediction.note] : 0;
}

/** Keeps predictions inside the time window and collapses duplicates of one arrival. */
export function usablePredictions(
  predictions: readonly Prediction[],
  feedAt: number
): Prediction[] {
  const earliest = feedAt - placementParameters.predictionWindowBeforeSeconds * 1000;
  const latest = feedAt + placementParameters.predictionWindowAfterSeconds * 1000;
  const sorted = predictions
    .filter((prediction) => prediction.expectedAt >= earliest && prediction.expectedAt <= latest)
    .sort(
      (left, right) =>
        left.lineId.localeCompare(right.lineId) ||
        left.stopId.localeCompare(right.stopId) ||
        left.destinationStopId.localeCompare(right.destinationStopId) ||
        left.expectedAt - right.expectedAt ||
        rankOf(right) - rankOf(left)
    );
  const kept: Prediction[] = [];
  for (const prediction of sorted) {
    const previous = kept.at(-1);
    if (
      previous?.lineId === prediction.lineId &&
      previous.stopId === prediction.stopId &&
      previous.destinationStopId === prediction.destinationStopId &&
      prediction.expectedAt - previous.expectedAt <= placementParameters.duplicateSeconds * 1000
    ) {
      if (rankOf(prediction) > rankOf(previous)) kept[kept.length - 1] = prediction;
      continue;
    }
    kept.push(prediction);
  }
  return kept;
}

/** A coarse location, the current edge or stop, used to check that branch candidates agree. */
function locationKey(timeline: PatternTimeline, x: number): string {
  const position = positionAt(timeline, x);
  switch (position.kind) {
    case "moving":
      return `edge:${edgeKey(
        timeline.stopIds[position.segmentIndex] ?? "",
        timeline.stopIds[position.segmentIndex + 1] ?? ""
      )}`;
    case "docked":
    case "terminus":
      return `stop:${timeline.stopIds[position.stopIndex] ?? ""}`;
    case "not_started":
      return "not_started";
  }
}

/**
 * Places each prediction on every pattern that can carry it. A train that has not left its origin
 * is kept, hidden until it departs. Branch predictions are dropped unless every candidate puts the
 * train on the same edge or stop now.
 */
export function projectPredictions(
  predictions: readonly Prediction[],
  network: PatternNetwork,
  feedAt: number
): Projection[] {
  const projections: Projection[] = [];
  for (const prediction of predictions) {
    const candidates: Projection[] = [];
    for (const pattern of network.lines.get(prediction.lineId) ?? []) {
      const destinationIndexes = pattern.stopIndexes.get(prediction.destinationStopId) ?? [];
      for (const stopIndex of pattern.stopIndexes.get(prediction.stopId) ?? []) {
        if (stopIndex === 0 || !destinationIndexes.some((index) => index >= stopIndex)) continue;
        candidates.push({
          patternId: pattern.timeline.id,
          stopIndex,
          virtualStartAt: prediction.expectedAt - (pattern.timeline.arr[stopIndex] ?? 0) * 1000,
          prediction
        });
      }
    }
    if (candidates.length === 0) continue;
    const keys = candidates.map((candidate) => {
      const timeline = network.patterns.get(candidate.patternId)?.timeline;
      return timeline
        ? locationKey(timeline, (feedAt - candidate.virtualStartAt) / 1000)
        : "not_started";
    });
    if (candidates.length > 1 && (keys.includes("not_started") || new Set(keys).size > 1)) {
      continue;
    }
    projections.push(...candidates);
  }
  return projections;
}

/**
 * A cluster's τ0, from its most reliable member: a train at the platform, then one approaching,
 * then the soonest countdown that is not long past.
 */
function bestMemberStart(
  members: readonly Projection[],
  timeline: PatternTimeline,
  feedAt: number
) {
  const countdown = (member: Projection) => (member.prediction.expectedAt - feedAt) / 1000;
  const byCountdown = (left: Projection, right: Projection) =>
    Math.abs(countdown(left)) - Math.abs(countdown(right));
  const docked = members.filter((member) => member.prediction.note === "at_platform");
  const dockedBest = [...docked].sort(byCountdown)[0];
  if (dockedBest) {
    return dockedBest.prediction.expectedAt - (timeline.dep[dockedBest.stopIndex] ?? 0) * 1000;
  }
  const approaching = members.filter((member) => member.prediction.note === "approaching");
  const nearest =
    [...approaching].sort(byCountdown)[0] ??
    members
      .filter(
        (member) => countdown(member) >= placementParameters.bestMemberMinimumCountdownSeconds
      )
      .sort((left, right) => countdown(left) - countdown(right))[0] ??
    [...members].sort((left, right) => countdown(right) - countdown(left))[0];
  return nearest?.virtualStartAt ?? 0;
}

/** Groups each pattern's projections into trains: consecutive τ0 values closer than G. */
export function clusterProjections(
  projections: readonly Projection[],
  network: PatternNetwork,
  feedAt: number
): Cluster[] {
  const byPattern = new Map<string, Projection[]>();
  for (const projection of projections) {
    byPattern.set(projection.patternId, [
      ...(byPattern.get(projection.patternId) ?? []),
      projection
    ]);
  }
  const clusters: Cluster[] = [];
  for (const [patternId, members] of [...byPattern].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const timeline = network.patterns.get(patternId)?.timeline;
    if (!timeline) continue;
    const sorted = [...members].sort(
      (left, right) =>
        left.virtualStartAt - right.virtualStartAt || left.stopIndex - right.stopIndex
    );
    const groups: Projection[][] = [];
    for (const member of sorted) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      if (
        group &&
        previous &&
        member.virtualStartAt - previous.virtualStartAt <
          placementParameters.sameTrainGapSeconds * 1000
      ) {
        group.push(member);
      } else {
        groups.push([member]);
      }
    }
    for (const group of groups) {
      clusters.push({
        lineId: timeline.lineId,
        patternId,
        virtualStartAt: bestMemberStart(group, timeline, feedAt),
        support: new Set(group.map((member) => member.prediction)).size,
        hasNote: group.some((member) => member.prediction.note !== undefined)
      });
    }
  }
  return clusters;
}

/** Every timeline point equivalent to position `x` on `patternId`, across the line's patterns. */
export function trackPoints(patternId: string, x: number, network: PatternNetwork): TrackPoint[] {
  const pattern = network.patterns.get(patternId);
  if (!pattern) return [];
  const timeline = pattern.timeline;
  const position = positionAt(timeline, x);
  if (position.kind === "not_started") return [];
  const points: TrackPoint[] = [{ patternId, x }];
  for (const other of network.lines.get(timeline.lineId) ?? []) {
    if (other === pattern) continue;
    const target = other.timeline;
    if (position.kind === "moving") {
      const index = position.segmentIndex;
      const departure = timeline.dep[index] ?? 0;
      const run = (timeline.arr[index + 1] ?? departure) - departure;
      const fraction = run > 0 ? (x - departure) / run : 0;
      const key = edgeKey(timeline.stopIds[index] ?? "", timeline.stopIds[index + 1] ?? "");
      for (const segment of other.segmentIndexes.get(key) ?? []) {
        const start = target.dep[segment] ?? 0;
        points.push({
          patternId: target.id,
          x: start + fraction * ((target.arr[segment + 1] ?? start) - start)
        });
      }
    } else {
      const stopIndex = position.stopIndex;
      const previous = timeline.stopIds[stopIndex - 1];
      const next = timeline.stopIds[stopIndex + 1];
      const dwellElapsed = position.kind === "docked" ? x - (timeline.arr[stopIndex] ?? 0) : 0;
      for (const stop of other.stopIndexes.get(timeline.stopIds[stopIndex] ?? "") ?? []) {
        // Same platform only when the patterns share the approach or the departure edge.
        const samePlatform =
          (previous !== undefined && previous === target.stopIds[stop - 1]) ||
          (next !== undefined && next === target.stopIds[stop + 1]);
        if (!samePlatform) continue;
        const arrival = target.arr[stop] ?? 0;
        points.push({
          patternId: target.id,
          x: arrival + Math.min(dwellElapsed, (target.dep[stop] ?? arrival) - arrival)
        });
      }
    }
  }
  return points;
}

/** True when two trains are within G of each other on some shared track. */
export function pointsConflict(left: readonly TrackPoint[], right: readonly TrackPoint[]): boolean {
  return left.some((a) =>
    right.some(
      (b) =>
        a.patternId === b.patternId && Math.abs(a.x - b.x) < placementParameters.sameTrainGapSeconds
    )
  );
}
