import {
  buildPatternTimelines,
  indexPatterns,
  mergedCoastingTrainIds,
  pointsConflict,
  positionAt,
  timelineSeconds,
  trackPoints,
  TrainTracker,
  type PatternTimeline,
  type TrackerSnapshot
} from "@paris-transit/transit-core";
import { describe, expect, it } from "vitest";

import { loadNetworkManifest, loadSegmentTimes, trainLineIds } from "../network-data.js";
import { TrainSimulator, type SimulatorOptions } from "./simulator.js";

const start = Date.parse("2026-09-28T07:00:00.000Z");
const refreshMs = 120_000;
const arrivalDelayMs = 20_000;
const sampleMs = 10_000;
const warmUpMs = 10 * 60_000;

/** The default network, optionally narrowed to some lines to keep long runs fast. */
async function network(only?: readonly string[]) {
  const manifest = await loadNetworkManifest();
  const lineIds = trainLineIds(manifest).filter((lineId) => !only || only.includes(lineId));
  const timelines = buildPatternTimelines(manifest, await loadSegmentTimes()).filter((timeline) =>
    lineIds.includes(timeline.lineId)
  );
  return { timelines, lineIds };
}

type Sample = { at: number; snapshot: TrackerSnapshot };

function simulate(
  timelines: readonly PatternTimeline[],
  lineIds: readonly string[],
  options: SimulatorOptions,
  durationMs: number,
  onSample: (sample: Sample, simulator: TrainSimulator) => void
): TrackerSnapshot {
  const simulator = new TrainSimulator(timelines, lineIds, options);
  const tracker = new TrainTracker(timelines, lineIds);
  let snapshot = tracker.snapshot(start);
  for (let feedAt = start; feedAt < start + durationMs; feedAt += refreshMs) {
    const receivedAt = feedAt + arrivalDelayMs;
    tracker.refresh(
      { source: "fixture", feedAt, receivedAt, predictions: simulator.predictionsAt(feedAt) },
      receivedAt
    );
    snapshot = tracker.snapshot(receivedAt);
    for (let at = receivedAt; at < receivedAt + refreshMs; at += sampleMs) {
      onSample({ at, snapshot }, simulator);
    }
  }
  return snapshot;
}

function scoreRun(timelines: readonly PatternTimeline[], lineIds: readonly string[], seed: number) {
  const network = indexPatterns(timelines);
  const byId = new Map(timelines.map((timeline) => [timeline.id, timeline]));
  let truthCount = 0;
  let placed = 0;
  let stacked = 0;
  let shownTotal = 0;
  let samples = 0;
  simulate(timelines, lineIds, { seed }, 3 * 60 * 60_000, ({ at, snapshot }, simulator) => {
    const merged = mergedCoastingTrainIds(snapshot.trains, network, at);
    const shown = snapshot.trains.flatMap((train) => {
      if (merged.has(train.id)) return [];
      const timeline = byId.get(train.patternId);
      if (!timeline) return [];
      const x = timelineSeconds(train, timeline, at);
      const last = timeline.arr.at(-1) ?? 0;
      if (positionAt(timeline, x).kind === "not_started" || x >= last + 60) return [];
      return [{ lineId: train.lineId, points: trackPoints(train.patternId, x, network) }];
    });
    for (let left = 0; left < shown.length; left += 1) {
      for (let right = left + 1; right < shown.length; right += 1) {
        const a = shown[left];
        const b = shown[right];
        if (a && b && a.lineId === b.lineId && pointsConflict(a.points, b.points)) stacked += 1;
      }
    }
    if (at < start + warmUpMs) return;
    const pointsByPattern = new Map<string, number[]>();
    for (const point of shown.flatMap((train) => train.points)) {
      pointsByPattern.set(point.patternId, [
        ...(pointsByPattern.get(point.patternId) ?? []),
        point.x
      ]);
    }
    for (const truth of simulator.truthAt(at)) {
      truthCount += 1;
      if ((pointsByPattern.get(truth.patternId) ?? []).some((x) => Math.abs(x - truth.x) <= 30)) {
        placed += 1;
      }
    }
    shownTotal += shown.length;
    samples += 1;
  });
  return { placedShare: placed / truthCount, stacked, averageShown: shownTotal / samples };
}

describe("seeded train simulator", () => {
  it("places at least 95% of trains within 30 s and never stacks them", async () => {
    const { timelines, lineIds } = await network();
    const result = scoreRun(timelines, lineIds, 7);
    expect(result.placedShare).toBeGreaterThanOrEqual(0.95);
    expect(result.stacked).toBe(0);
    expect(result.averageShown).toBeGreaterThan(0);
  }, 60_000);

  it("freezes a silent line and resumes it when data returns", async () => {
    const { timelines, lineIds } = await network(["metro-1", "metro-7"]);
    const outage = { lineId: "metro-1", from: start + 30 * 60_000, to: start + 40 * 60_000 };
    const states: string[] = [];
    let frozenTrains = 0;
    simulate(timelines, lineIds, { seed: 7, outage }, 60 * 60_000, ({ at, snapshot }) => {
      const line = snapshot.lines.find((candidate) => candidate.lineId === "metro-1");
      if (line && states.at(-1) !== line.state) states.push(line.state);
      if (at >= outage.from + 60_000 && at < outage.to) {
        const trains = snapshot.trains.filter((train) => train.lineId === "metro-1");
        frozenTrains = Math.max(frozenTrains, trains.length);
        expect(trains.every((train) => train.state === "frozen")).toBe(true);
      }
    });
    expect(states).toEqual(["live", "frozen", "live"]);
    expect(frozenTrains).toBeGreaterThanOrEqual(3);
  });

  it("reproduces identical snapshots from the same seed", async () => {
    const { timelines, lineIds } = await network(["metro-1", "metro-7"]);
    const run = () => simulate(timelines, lineIds, { seed: 3 }, 30 * 60_000, () => undefined);
    expect(run()).toEqual(run());
  });
});
