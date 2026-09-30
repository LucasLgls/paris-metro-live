import { describe, expect, it } from "vitest";

import { FixtureRealtimeSource } from "./fixture-source.js";

const timeline = {
  id: "east",
  lineId: "line",
  name: "C",
  stopIds: ["a", "b", "c"],
  arr: [0, 60, 140],
  dep: [0, 80, 140]
};

describe("fixture source adapter", () => {
  it("publishes deterministic countdowns on 120 s provider refresh boundaries", async () => {
    const at = (iso: string) => () => new Date(iso);
    const first = await new FixtureRealtimeSource(
      [timeline],
      ["line"],
      at("2026-09-28T07:31:10.000Z")
    ).poll();
    const again = await new FixtureRealtimeSource(
      [timeline],
      ["line"],
      at("2026-09-28T07:31:50.000Z")
    ).poll();

    expect(first.feedAt).toBe(Date.parse("2026-09-28T07:30:00.000Z"));
    expect(again.predictions).toEqual(first.predictions);
    expect(first.predictions.length).toBeGreaterThan(0);
    expect(first.predictions.every((prediction) => prediction.destinationStopId === "c")).toBe(
      true
    );
  });
});
