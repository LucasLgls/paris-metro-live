import { trainSnapshotSchemaVersion } from "@paris-transit/contracts";
import { describe, expect, it } from "vitest";
import { parseTrainEvent } from "./client.js";

const train = {
  id: "t1",
  lineId: "metro-1",
  patternId: "metro-1-east",
  destinationName: "Château de Vincennes",
  virtualStartAt: "2026-09-28T07:12:00.000Z",
  lastEvidenceAt: "2026-09-28T07:30:00.000Z",
  state: "live",
  stateSince: "2026-09-28T07:14:00.000Z"
};

const snapshot = {
  schemaVersion: trainSnapshotSchemaVersion,
  sequence: 3,
  topologyVersion: "fixture-v1",
  feedAt: "2026-09-28T07:30:00.000Z",
  generatedAt: "2026-09-28T07:30:20.000Z",
  lines: [{ lineId: "metro-1", state: "live" }],
  trains: [train]
};

describe("train stream validation", () => {
  it("accepts a valid snapshot event", () => {
    expect(parseTrainEvent(JSON.stringify(snapshot))?.trains).toHaveLength(1);
  });

  it("rejects malformed events instead of showing an untrusted train", () => {
    expect(
      parseTrainEvent(JSON.stringify({ ...snapshot, trains: [{ ...train, state: "hidden" }] }))
    ).toBeNull();
    expect(parseTrainEvent("not json")).toBeNull();
  });
});
