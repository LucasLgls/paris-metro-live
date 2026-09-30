import { describe, expect, it } from "vitest";

import { indexPatterns, mergedCoastingTrainIds, type DisplayTrain } from "./display.js";
import { testTimelines } from "./test-network.js";

const network = indexPatterns(testTimelines);
const now = Date.parse("2026-09-28T07:30:00.000Z");

function train(id: string, x: number, overrides: Partial<DisplayTrain> = {}): DisplayTrain {
  return {
    id,
    lineId: "L",
    patternId: "east",
    virtualStartAt: now - x * 1000,
    state: "live",
    stateSince: now - 60_000,
    lastEvidenceAt: now - 60_000,
    ...overrides
  };
}

const holding = (x: number, id = "held") =>
  train(id, x, { state: "coasting", holdStopIndex: 2, lastEvidenceAt: now - 120_000 });

describe("coasting merges", () => {
  it("keeps a coasting train while no live train reaches it", () => {
    // Held at c (x = 140); the follower is 60 s behind.
    expect(mergedCoastingTrainIds([holding(400), train("follower", 80)], network, now).size).toBe(
      0
    );
  });

  it("merges a coasting train into a live train within 45 s", () => {
    const merged = mergedCoastingTrainIds([holding(400), train("follower", 100)], network, now);
    expect([...merged]).toEqual(["held"]);
  });

  it("keeps it merged after the live train has passed", () => {
    // The follower was 60 s behind when the train began to coast, and is now 40 s past c.
    const held = { ...holding(400), stateSince: now - 120_000 };
    const merged = mergedCoastingTrainIds([held, train("follower", 180)], network, now);
    expect([...merged]).toEqual(["held"]);
  });

  it("merges the coasting train with older evidence when two wait together", () => {
    const fresher = { ...holding(400, "fresher"), lastEvidenceAt: now - 30_000 };
    const merged = mergedCoastingTrainIds([holding(300, "older"), fresher], network, now);
    expect([...merged]).toEqual(["older"]);
  });

  it("never merges live trains", () => {
    expect(mergedCoastingTrainIds([train("a", 100), train("b", 110)], network, now).size).toBe(0);
  });
});
