/**
 * Pattern timelines. A train is placed by one number, τ0 (`virtualStartAt`): the time it would have
 * left its pattern's origin. At wall time τ, it is `x = τ − τ0` seconds along its timeline.
 */

import type { NetworkManifest, SegmentTimes } from "@paris-transit/contracts";

/**
 * One direction pattern on its timetable timeline. `arr[i]` and `dep[i]` are seconds after the
 * origin departure; segment `i` runs from `dep[i]` to `arr[i + 1]`.
 */
export type PatternTimeline = {
  id: string;
  lineId: string;
  name: string;
  stopIds: readonly string[];
  arr: readonly number[];
  dep: readonly number[];
};

/**
 * `live`: seen in the latest feed. `coasting`: missing from it, so it runs on to its next stop and
 * waits there. `frozen`: its line or the whole feed went quiet, so it stays where it was.
 */
export type TrainState = "live" | "coasting" | "frozen";

/** The timing fields needed to place a train; times are epoch milliseconds. */
export type TimelineTrain = {
  virtualStartAt: number;
  state: TrainState;
  stateSince: number;
  holdStopIndex?: number | undefined;
};

/** Where a train is on its pattern at one instant. */
export type TimelinePosition =
  | { kind: "not_started" }
  | { kind: "docked"; stopIndex: number }
  | { kind: "moving"; segmentIndex: number; progress: number }
  | { kind: "terminus"; stopIndex: number; secondsSinceArrival: number };

/** One timeline per direction whose segment times match its stop list; others are skipped. */
export function buildPatternTimelines(
  manifest: NetworkManifest,
  segmentTimes: SegmentTimes
): PatternTimeline[] {
  const timelines: PatternTimeline[] = [];
  for (const line of manifest.lines) {
    for (const direction of line.directions) {
      const segments = segmentTimes.segments[direction.id];
      const stopIds = direction.stopIds;
      if (
        segments?.length !== stopIds.length - 1 ||
        segments.some(
          (segment, index) =>
            segment.fromStopId !== stopIds[index] || segment.toStopId !== stopIds[index + 1]
        )
      ) {
        continue;
      }
      const arr = [0];
      const dep = [0];
      segments.forEach((segment, index) => {
        const arrival = (dep[index] ?? 0) + segment.runSeconds;
        arr.push(arrival);
        dep.push(arrival + (segments[index + 1]?.dwellSeconds ?? 0));
      });
      timelines.push({
        id: direction.id,
        lineId: line.id,
        name: direction.name,
        stopIds: [...stopIds],
        arr,
        dep
      });
    }
  }
  return timelines;
}

/** Eases 0–1 progress so trains accelerate out of and brake into stations. */
export function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** Where a train is `x` seconds after its virtual origin departure. */
export function positionAt(timeline: PatternTimeline, x: number): TimelinePosition {
  const last = timeline.stopIds.length - 1;
  const lastArrival = timeline.arr[last] ?? 0;
  if (x < 0) return { kind: "not_started" };
  if (x >= lastArrival) {
    return { kind: "terminus", stopIndex: last, secondsSinceArrival: x - lastArrival };
  }
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((timeline.arr[middle] ?? 0) <= x) low = middle;
    else high = middle - 1;
  }
  const departure = timeline.dep[low] ?? 0;
  if (x < departure) return { kind: "docked", stopIndex: low };
  const run = (timeline.arr[low + 1] ?? departure) - departure;
  return {
    kind: "moving",
    segmentIndex: low,
    progress: smoothstep(run > 0 ? (x - departure) / run : 1)
  };
}

/** Seconds along the pattern timeline: frozen trains stop at their freeze instant and coasting
 * trains wait docked at their hold stop. */
export function timelineSeconds(
  train: TimelineTrain,
  timeline: PatternTimeline,
  now: number
): number {
  const at = train.state === "frozen" ? Math.min(now, train.stateSince) : now;
  const x = (at - train.virtualStartAt) / 1000;
  const hold = train.holdStopIndex === undefined ? undefined : timeline.arr[train.holdStopIndex];
  return hold === undefined ? x : Math.min(x, hold);
}
