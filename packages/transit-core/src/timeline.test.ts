import type { NetworkManifest, SegmentTimes } from "@paris-transit/contracts";
import { describe, expect, it } from "vitest";

import { testTimeline } from "./test-network.js";
import { buildPatternTimelines, positionAt, smoothstep, timelineSeconds } from "./timeline.js";

const geometry = {
  type: "LineString" as const,
  coordinates: [
    [2.3, 48.8],
    [2.4, 48.9]
  ] as [number, number][]
};

const manifest: NetworkManifest = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  generatedAt: "2026-09-28T00:00:00.000Z",
  source: "test",
  attribution: "test",
  stops: [],
  lines: [
    {
      id: "L",
      code: "L",
      name: "Line",
      mode: "metro",
      color: "#FFCD00",
      textColor: "#000000",
      operator: "test",
      capability: "estimated_segment",
      directions: [
        { id: "east", name: "C", stopIds: ["a", "b", "c"], geometry },
        { id: "broken", name: "A", stopIds: ["c", "b", "a"], geometry }
      ]
    }
  ]
};

const segmentTimes: SegmentTimes = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  segments: {
    east: [
      { fromStopId: "a", toStopId: "b", runSeconds: 70, dwellSeconds: 30 },
      { fromStopId: "b", toStopId: "c", runSeconds: 50, dwellSeconds: 15 }
    ],
    broken: [{ fromStopId: "c", toStopId: "b", runSeconds: 70, dwellSeconds: 0 }]
  }
};

describe("pattern timelines", () => {
  it("accumulates runs and from-stop dwells from the origin departure", () => {
    const [timeline, ...rest] = buildPatternTimelines(manifest, segmentTimes);
    expect(rest).toHaveLength(0);
    expect(timeline).toMatchObject({
      id: "east",
      lineId: "L",
      name: "C",
      arr: [0, 70, 135],
      dep: [0, 85, 135]
    });
  });

  it("places a train by its timeline seconds", () => {
    const timeline = testTimeline("east", "L", ["a", "b", "c", "d", "e"]);
    expect(timeline.arr).toEqual([0, 60, 140, 220, 300]);
    expect(timeline.dep).toEqual([0, 80, 160, 240, 300]);
    expect(positionAt(timeline, -1)).toEqual({ kind: "not_started" });
    expect(positionAt(timeline, 0)).toEqual({ kind: "moving", segmentIndex: 0, progress: 0 });
    expect(positionAt(timeline, 15)).toEqual({
      kind: "moving",
      segmentIndex: 0,
      progress: smoothstep(0.25)
    });
    expect(positionAt(timeline, 60)).toEqual({ kind: "docked", stopIndex: 1 });
    expect(positionAt(timeline, 110)).toEqual({ kind: "moving", segmentIndex: 1, progress: 0.5 });
    expect(positionAt(timeline, 330)).toEqual({
      kind: "terminus",
      stopIndex: 4,
      secondsSinceArrival: 30
    });
  });

  it("eases into and out of stations without changing segment duration", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.1)).toBeLessThan(0.1);
    expect(smoothstep(0.9)).toBeGreaterThan(0.9);
  });

  it("stops frozen trains at their freeze instant and holds coasting trains", () => {
    const timeline = testTimeline("east", "L", ["a", "b", "c", "d", "e"]);
    const start = 1_000_000;
    expect(
      timelineSeconds(
        { virtualStartAt: start, state: "frozen", stateSince: start + 50_000 },
        timeline,
        start + 500_000
      )
    ).toBe(50);
    expect(
      timelineSeconds(
        { virtualStartAt: start, state: "coasting", stateSince: start, holdStopIndex: 2 },
        timeline,
        start + 500_000
      )
    ).toBe(140);
    expect(
      timelineSeconds(
        { virtualStartAt: start, state: "live", stateSince: start },
        timeline,
        start + 90_000
      )
    ).toBe(90);
  });
});
