import { describe, expect, it } from "vitest";

import { indexPatterns, pointsConflict, trackPoints } from "./estimator.js";
import { testTimelines } from "./test-network.js";
import { timelineSeconds } from "./timeline.js";
import { TrainTracker, type TrackedTrain } from "./tracker.js";
import type { Prediction, RealtimeFeed } from "./types.js";

const start = Date.parse("2026-09-28T07:30:00.000Z");
const minutes = (value: number) => start + value * 60_000;
const network = indexPatterns(testTimelines);

function feed(feedAt: number, predictions: Prediction[]): RealtimeFeed {
  return { source: "fixture", feedAt, receivedAt: feedAt, predictions };
}

/** Predictions for a train on "east" that is at timeline second `x` at `feedAt`. */
function eastTrain(
  feedAt: number,
  x: number,
  stops: ("b" | "c" | "d" | "e")[],
  note?: Prediction["note"]
): Prediction[] {
  const arrivals = { b: 60, c: 140, d: 220, e: 300 };
  return stops.map((stopId, index) => ({
    lineId: "L",
    stopId,
    destinationStopId: "e",
    expectedAt: feedAt + (arrivals[stopId] - x) * 1000,
    ...(note && index === 0 ? { note } : {})
  }));
}

function tracker() {
  return new TrainTracker(testTimelines, ["L", "B"]);
}

function trains(value: TrainTracker, now: number, lineId = "L"): TrackedTrain[] {
  return value.snapshot(now).trains.filter((train) => train.lineId === lineId);
}

describe("train tracker", () => {
  it("needs two predictions or a note to create a train", () => {
    const single = tracker();
    single.refresh(feed(start, eastTrain(start, 100, ["c"])), start);
    expect(trains(single, start)).toHaveLength(0);

    const noted = tracker();
    noted.refresh(feed(start, eastTrain(start, 100, ["c"], "approaching")), start);
    expect(trains(noted, start)).toHaveLength(1);

    const supported = tracker();
    supported.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    expect(trains(supported, start)).toMatchObject([
      { lineId: "L", patternId: "east", destinationName: "e", state: "live" }
    ]);
  });

  it("keeps a train alive with a single prediction and keeps its identifier", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 20, ["b", "c"])), start);
    const [born] = trains(value, start);
    const next = minutes(2);
    value.refresh(feed(next, eastTrain(next, 150, ["d"])), next);
    const [kept] = trains(value, next);
    expect(kept?.id).toBe(born?.id);
    expect(kept?.state).toBe("live");
    expect(kept?.lastEvidenceAt).toBe(next);
    expect(kept?.virtualStartAt).toBe(next - 150_000);
  });

  it("creates two trains 60 s apart and never stacks trains on one track", () => {
    const value = tracker();
    value.refresh(
      feed(start, [...eastTrain(start, 190, ["d", "e"]), ...eastTrain(start, 130, ["d", "e"])]),
      start
    );
    const result = trains(value, start);
    expect(result).toHaveLength(2);
    const [first, second] = result.map((train) =>
      trackPoints(train.patternId, (start - train.virtualStartAt) / 1000, network)
    );
    expect(first && second && pointsConflict(first, second)).toBe(false);
  });

  it("keeps one train when both branch patterns report it on the shared trunk", () => {
    const value = tracker();
    const predictions = [
      { stopId: "t1", seconds: 30 },
      { stopId: "t2", seconds: 110 }
    ].map(({ stopId, seconds }) => ({
      lineId: "B",
      stopId,
      destinationStopId: "t2",
      expectedAt: start + seconds * 1000
    }));
    value.refresh(feed(start, predictions), start);
    expect(trains(value, start, "B")).toHaveLength(1);
  });

  it("coasts to the next stop, waits there, and is removed after five minutes", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    const next = minutes(2);
    value.refresh(feed(next, []), next);
    const [coasting] = trains(value, next);
    // At the refresh it is at x = 220 (docked at d), so it holds at d.
    expect(coasting).toMatchObject({ state: "coasting", holdStopIndex: 3, stateSince: next });
    const timeline = testTimelines[0];
    if (!coasting || !timeline) throw new Error("missing train");
    expect(timelineSeconds(coasting, timeline, minutes(4))).toBe(220);
    expect(trains(value, start + 299_000)).toHaveLength(1);
    expect(trains(value, start + 300_000)).toHaveLength(0);
  });

  it("re-matches a coasting train within 240 s but a live train only within 120 s", () => {
    const next = minutes(2);
    const coasting = tracker();
    coasting.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    const [born] = trains(coasting, start);
    coasting.refresh(feed(minutes(1), []), minutes(1));
    // Nominally at x = 220 now; reported 150 s behind, at x = 70.
    coasting.refresh(feed(next, eastTrain(next, 70, ["c"])), next);
    expect(trains(coasting, next)).toMatchObject([{ id: born?.id, state: "live" }]);

    const live = tracker();
    live.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    live.refresh(feed(next, eastTrain(next, 70, ["c"])), next);
    expect(trains(live, next)).toMatchObject([{ id: born?.id, state: "coasting" }]);
  });

  it("merges a coasting train into a new train at its position", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 10, ["b", "c"])), start);
    const [born] = trains(value, start);
    value.refresh(feed(minutes(1), []), minutes(1));
    expect(trains(value, minutes(1))).toMatchObject([{ state: "coasting", holdStopIndex: 1 }]);
    // Held at b (x = 60); a new train is reported 30 s short of b, 250 s off its old τ0.
    const later = start + 270_000;
    value.refresh(feed(later, eastTrain(later, 30, ["b", "c"])), later);
    expect(trains(value, later)).toMatchObject([
      { id: born?.id, state: "live", virtualStartAt: later - 30_000 }
    ]);
  });

  it("tracks a train waiting at its origin and places it once it departs", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, -30, ["b", "c"])), start);
    const [waiting] = trains(value, start);
    const timeline = testTimelines[0];
    if (!waiting || !timeline) throw new Error("missing train");
    expect(timelineSeconds(waiting, timeline, start)).toBe(-30);
    expect(timelineSeconds(waiting, timeline, start + 40_000)).toBe(10);
  });

  it("removes a train 60 s after it reaches its terminus", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 250, ["e"], "approaching")), start);
    expect(trains(value, start + 109_000)).toHaveLength(1);
    expect(trains(value, start + 110_000)).toHaveLength(0);
  });

  it("freezes a silent line, resumes it, and removes unmatched frozen trains", () => {
    const value = tracker();
    const three = [
      ...eastTrain(start, 10, ["b", "c"]),
      ...eastTrain(start, 100, ["c", "d"]),
      ...eastTrain(start, 190, ["d", "e"])
    ];
    value.refresh(feed(start, three), start);
    expect(trains(value, start)).toHaveLength(3);

    const silent = minutes(2);
    value.refresh(feed(silent, []), silent + 5_000);
    const frozen = value.snapshot(minutes(10));
    expect(frozen.lines.find((line) => line.lineId === "L")).toEqual({
      lineId: "L",
      state: "frozen",
      since: silent + 5_000
    });
    expect(frozen.trains.filter((train) => train.lineId === "L")).toHaveLength(3);
    expect(frozen.trains.every((train) => train.lineId !== "L" || train.state === "frozen")).toBe(
      true
    );

    const back = minutes(4);
    value.refresh(feed(back, eastTrain(back, 10 + 240, ["e"])), back + 1_000);
    const resumed = value.snapshot(back + 1_000);
    expect(resumed.lines.find((line) => line.lineId === "L")?.state).toBe("live");
    expect(resumed.trains.filter((train) => train.lineId === "L")).toMatchObject([
      { state: "live", stateSince: back + 1_000 }
    ]);
  });

  it("does not freeze a line that had fewer than three trains", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    value.refresh(feed(minutes(2), []), minutes(2));
    expect(value.snapshot(minutes(2)).lines.find((line) => line.lineId === "L")?.state).toBe(
      "live"
    );
  });

  it("freezes every line when the feed fails or is older than five minutes", () => {
    const failed = tracker();
    failed.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    failed.freezeAll(minutes(1));
    expect(failed.snapshot(minutes(1)).lines.every((line) => line.state === "frozen")).toBe(true);
    expect(trains(failed, minutes(30))).toMatchObject([
      { state: "frozen", stateSince: minutes(1) }
    ]);

    const stale = tracker();
    stale.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    stale.refresh(feed(minutes(1), eastTrain(minutes(1), 160, ["d"])), minutes(6) + 1);
    expect(stale.snapshot(minutes(6)).lines.every((line) => line.state === "frozen")).toBe(true);
  });

  it("removes frozen trains after three hours but keeps the line paused", () => {
    const value = tracker();
    value.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
    value.freezeAll(minutes(1));
    expect(trains(value, minutes(1) + 3 * 3_600_000 - 1)).toHaveLength(1);
    const capped = value.snapshot(minutes(1) + 3 * 3_600_000);
    expect(capped.trains).toHaveLength(0);
    expect(capped.lines.every((line) => line.state === "frozen")).toBe(true);
  });

  it("produces identical snapshots for identical inputs", () => {
    const run = () => {
      const value = tracker();
      value.refresh(feed(start, eastTrain(start, 100, ["c", "d"])), start);
      value.refresh(feed(minutes(2), eastTrain(minutes(2), 215, ["d", "e"])), minutes(2));
      return value.snapshot(minutes(2));
    };
    expect(run()).toEqual(run());
  });
});
