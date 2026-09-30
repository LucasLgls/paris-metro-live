import { describe, expect, it } from "vitest";
import type { NetworkManifest, SegmentTimes } from "@paris-transit/contracts";
import type { DisplayTrain } from "@paris-transit/transit-core/display";
import { buildDisplayLayout, pointAlongDisplaySegment, stationPortKey } from "./route-geometry.js";
import {
  buildTrainNetwork,
  createMotionState,
  trainFrame,
  visibleTrainCounts,
  type MotionState,
  type TrainScene
} from "./train-motion.js";

const stopIds = ["a", "b", "c", "d", "e"];
const manifest: NetworkManifest = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  generatedAt: "2026-09-28T12:00:00.000Z",
  source: "test",
  attribution: "Test data",
  lines: [
    {
      id: "metro-1",
      code: "1",
      name: "Métro 1",
      mode: "metro",
      color: "#FFCE00",
      textColor: "#000000",
      operator: "Test",
      capability: "estimated_segment",
      directions: [
        {
          id: "east",
          name: "E",
          stopIds,
          geometry: {
            type: "LineString",
            coordinates: stopIds.map((_, index) => [2.3 + index * 0.02, 48.85]),
            geometrySource: "fixture"
          }
        }
      ]
    }
  ],
  stops: stopIds.map((id, index) => ({
    id,
    name: id.toUpperCase(),
    longitude: 2.3 + index * 0.02,
    latitude: 48.85,
    lineIds: ["metro-1"]
  }))
};
// 60 s runs and 20 s dwells: arr = [0, 60, 140, 220, 300], dep = [0, 80, 160, 240, 300].
const segmentTimes: SegmentTimes = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  segments: {
    east: stopIds.slice(1).map((toStopId, index) => ({
      fromStopId: stopIds[index] ?? "",
      toStopId,
      runSeconds: 60,
      dwellSeconds: index === 0 ? 0 : 20
    }))
  }
};
const layout = buildDisplayLayout(manifest);
const network = buildTrainNetwork(manifest, segmentTimes);
const t0 = Date.parse("2026-09-28T12:00:00.000Z");

function scene(hubs: string[] = []): TrainScene {
  return { network, layout, hubStopIds: new Set(hubs) };
}

/** A train at `x` seconds along the timeline at `t0`. */
function train(id: string, x: number, extra: Partial<DisplayTrain> = {}): DisplayTrain {
  return {
    id,
    lineId: "metro-1",
    patternId: "east",
    virtualStartAt: t0 - x * 1000,
    lastEvidenceAt: t0,
    state: "live",
    stateSince: t0,
    ...extra
  };
}

function shown(state: MotionState, id: string): number | undefined {
  return state.trains.get(id)?.shown;
}

describe("train motion", () => {
  it("places moving trains on their display segment and docked trains at the station port", () => {
    const frame = trainFrame(
      [train("moving", 30), train("docked", 70)],
      scene(),
      createMotionState(),
      t0,
      false
    );
    const direction = layout.directions.get("east");
    const expected = direction && pointAlongDisplaySegment(direction, "a", "b", 0.5, 0);
    const moving = frame.trains.find((mark) => mark.id === "moving");
    const docked = frame.trains.find((mark) => mark.id === "docked");
    expect(moving?.longitude).toBeCloseTo(expected?.longitude ?? Number.NaN, 9);
    expect(moving?.bearing).toBeDefined();
    expect(docked?.bearing).toBeUndefined();
    expect([docked?.longitude, docked?.latitude]).toEqual(
      layout.stationPorts.get(stationPortKey("metro-1", "b"))
    );
  });

  it("never moves a train backwards; it waits for an estimate that fell behind", () => {
    const state = createMotionState();
    trainFrame([train("t", 50)], scene(), state, t0, false);
    const corrected = [train("t", 30)];
    let previous = shown(state, "t") ?? 0;
    for (let second = 1; second <= 60; second += 1) {
      trainFrame(corrected, scene(), state, t0 + second * 1000, false);
      const current = shown(state, "t") ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    // Having waited, it converges on the estimate from ahead.
    expect((shown(state, "t") ?? 0) - 90).toBeGreaterThanOrEqual(0);
    expect((shown(state, "t") ?? 0) - 90).toBeLessThan(0.5);
  });

  it("catches up with an estimate ahead of it at no more than twice timetable speed", () => {
    const state = createMotionState();
    trainFrame([train("t", 30)], scene(), state, t0, false);
    trainFrame([train("t", 60)], scene(), state, t0 + 1000, false);
    expect(shown(state, "t")).toBe(32);
  });

  it("cross-fades instead of gliding when the error exceeds 180 s", () => {
    const state = createMotionState();
    trainFrame([train("t", 10)], scene(), state, t0, false);
    trainFrame([train("t", 10)], scene(), state, t0 + 1000, false);
    const frame = trainFrame([train("t", 200)], scene(), state, t0 + 1000, false);
    expect(shown(state, "t")).toBe(201);
    expect(frame.ghosts).toHaveLength(1);
    expect(frame.ghosts[0]?.alpha).toBeGreaterThan(0);
    expect(frame.trains[0]?.alpha).toBe(0);
  });

  it("hides a train docked at a big interchange with a short fade", () => {
    const state = createMotionState();
    const trains = [train("t", 50)];
    // Keyed by tenths of a second after x = 50: it docks at b at 100 and departs at 300.
    const alphaAt: number[] = [];
    for (let tenth = 0; tenth <= 350; tenth += 1) {
      const frame = trainFrame(trains, scene(["b"]), state, t0 + tenth * 100, false);
      alphaAt.push(frame.trains[0]?.alpha ?? -1);
    }
    expect(alphaAt[90]).toBe(1);
    expect(alphaAt.slice(100, 104).some((alpha) => alpha > 0 && alpha < 1)).toBe(true);
    expect(alphaAt.slice(105, 300).every((alpha) => alpha === 0)).toBe(true);
    expect(alphaAt.slice(300, 304).some((alpha) => alpha > 0 && alpha < 1)).toBe(true);
    expect(alphaAt[305]).toBe(1);
  });

  it("dims frozen trains and holds them where they froze", () => {
    const state = createMotionState();
    const frozen = [train("t", 30, { state: "frozen", stateSince: t0 })];
    const first = trainFrame(frozen, scene(), state, t0, false);
    const later = trainFrame(frozen, scene(), state, t0 + 10_000, false);
    expect(later.trains[0]?.frozen).toBe(true);
    expect(later.trains[0]?.longitude).toBe(first.trains[0]?.longitude);
  });

  it("merges a waiting coasting train into the live train that reaches it", () => {
    const trains = [
      train("coasting", 200, { state: "coasting", holdStopIndex: 2, stateSince: t0 - 60_000 }),
      train("live", 110)
    ];
    const frame = trainFrame(trains, scene(), createMotionState(), t0, false);
    expect(frame.trains.map((mark) => mark.id)).toEqual(["live"]);
    expect(visibleTrainCounts(trains, network, t0).get("metro-1")).toBe(1);
  });

  it("jumps straight to the estimate without fades in reduced motion", () => {
    const state = createMotionState();
    expect(trainFrame([train("t", 50)], scene(), state, t0, true).trains[0]?.alpha).toBe(1);
    const frame = trainFrame([train("t", 30)], scene(), state, t0 + 15_000, true);
    expect(shown(state, "t")).toBe(45);
    expect(frame.ghosts).toEqual([]);
  });

  it("counts only trains that have left their origin and not yet finished their trip", () => {
    const trains = [train("waiting", -20), train("running", 100), train("finished", 400)];
    expect(visibleTrainCounts(trains, network, t0)).toEqual(new Map([["metro-1", 1]]));
  });
});
