import { describe, expect, it } from "vitest";

import {
  clusterProjections,
  indexPatterns,
  pointsConflict,
  projectPredictions,
  trackPoints,
  usablePredictions
} from "./estimator.js";
import { testTimelines } from "./test-network.js";
import type { Prediction } from "./types.js";

const network = indexPatterns(testTimelines);
const feedAt = Date.parse("2026-09-28T07:30:00.000Z");
const at = (seconds: number) => feedAt + seconds * 1000;

function prediction(
  stopId: string,
  countdownSeconds: number,
  options: { lineId?: string; destinationStopId?: string; note?: Prediction["note"] } = {}
): Prediction {
  return {
    lineId: options.lineId ?? "L",
    stopId,
    destinationStopId: options.destinationStopId ?? "e",
    expectedAt: at(countdownSeconds),
    ...(options.note ? { note: options.note } : {})
  };
}

function clustersFor(predictions: Prediction[]) {
  const usable = usablePredictions(predictions, feedAt);
  return clusterProjections(projectPredictions(usable, network, feedAt), network, feedAt);
}

describe("predictions", () => {
  it("keeps only the −60 s to +600 s window", () => {
    const kept = usablePredictions(
      [prediction("c", -61), prediction("c", -60), prediction("d", 600), prediction("d", 601)],
      feedAt
    );
    expect(kept.map((item) => item.expectedAt)).toEqual([at(-60), at(600)]);
  });

  it("collapses duplicates of one arrival and keeps the strongest note", () => {
    const kept = usablePredictions(
      [prediction("c", 20), prediction("c", 24, { note: "approaching" }), prediction("c", 40)],
      feedAt
    );
    expect(kept).toHaveLength(2);
    expect(kept[0]?.note).toBe("approaching");
  });
});

describe("projection", () => {
  it("turns a countdown into the train's virtual origin departure", () => {
    const [projection, ...rest] = projectPredictions([prediction("c", 30)], network, feedAt);
    expect(rest).toHaveLength(0);
    // c is reached 140 s after the origin departure on "east".
    expect(projection).toMatchObject({ patternId: "east", stopIndex: 2 });
    expect(projection?.virtualStartAt).toBe(at(30 - 140));
  });

  it("keeps a train that has not left its origin, hidden until it departs", () => {
    const [waiting] = projectPredictions([prediction("b", 90)], network, feedAt);
    // Due at b (60 s from the origin) in 90 s, so it departs 30 s after the feed.
    expect(waiting?.virtualStartAt).toBe(at(30));
  });

  it("drops a branch prediction when one candidate has not left its origin", () => {
    const options = { lineId: "B", destinationStopId: "t2" };
    expect(projectPredictions([prediction("m", 150, options)], network, feedAt)).toEqual([]);
  });

  it("uses the à quai departure and the approach arrival as anchors", () => {
    const [docked] = clustersFor([prediction("c", 5, { note: "at_platform" })]);
    // Docked at c until E: τ0 = E − dep[c] = 5 − 160.
    expect(docked?.virtualStartAt).toBe(at(5 - 160));

    const members = [prediction("c", -20), prediction("d", 25, { note: "approaching" })];
    expect(clustersFor(members)[0]?.virtualStartAt).toBe(at(25 - 220));
    const [plain] = clustersFor([prediction("c", -20), prediction("d", 25)]);
    expect(plain?.virtualStartAt).toBe(at(-20 - 140));
  });

  it("drops converging-branch predictions off the shared trunk", () => {
    const options = { lineId: "B", destinationStopId: "t2" };
    // x = 70: docked at x2 on b1 but at y2 on b2, so the branch is unknown.
    expect(projectPredictions([prediction("t1", 150, options)], network, feedAt)).toEqual([]);
    // x = 190: on m → t1 for both branches, so both projections are kept.
    const kept = projectPredictions([prediction("t1", 30, options)], network, feedAt);
    expect(kept.map((item) => item.patternId)).toEqual(["b1", "b2"]);
  });
});

describe("clustering", () => {
  it("merges several predictions of one train into one train", () => {
    const clusters = clustersFor([prediction("c", 30), prediction("d", 112), prediction("e", 190)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ patternId: "east", support: 3, hasNote: false });
  });

  it("keeps trains 60 s apart separate", () => {
    const clusters = clustersFor([prediction("d", 30), prediction("d", 90)]);
    expect(clusters.map((cluster) => cluster.virtualStartAt)).toEqual([at(30 - 220), at(90 - 220)]);
  });
});

describe("track conflicts", () => {
  it("compares positions across branch patterns that share the trunk", () => {
    const onB1 = trackPoints("b1", 190, network);
    const onB2 = trackPoints("b2", 200, network);
    expect(onB1).toContainEqual({ patternId: "b2", x: 190 });
    expect(pointsConflict(onB1, onB2)).toBe(true);
    expect(pointsConflict(onB1, trackPoints("b2", 236, network))).toBe(false);
    // Opposite platforms of one station never conflict.
    expect(
      pointsConflict(trackPoints("east", 150, network), trackPoints("west", 150, network))
    ).toBe(false);
    // Different branches before the merge never conflict.
    expect(pointsConflict(trackPoints("b1", 30, network), trackPoints("b2", 30, network))).toBe(
      false
    );
  });
});
