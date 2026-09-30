import { describe, expect, it } from "vitest";

import {
  schemaVersion,
  segmentTimesSchema,
  serviceStatusSchema,
  trainSnapshotSchema,
  trainSnapshotSchemaVersion
} from "./index.js";
import { openApiDocument } from "./openapi.js";

describe("segmentTimesSchema", () => {
  it("accepts a per-direction table of positive run times", () => {
    const result = segmentTimesSchema.safeParse({
      schemaVersion,
      topologyVersion: "test-v1",
      segments: {
        "metro-1-east": [
          {
            fromStopId: "la-defense",
            toStopId: "esplanade-de-la-defense",
            runSeconds: 75,
            dwellSeconds: 20
          }
        ]
      }
    });

    expect(result.success).toBe(true);
  });

  it("rejects a non-positive run time", () => {
    const result = segmentTimesSchema.safeParse({
      schemaVersion,
      topologyVersion: "test-v1",
      segments: {
        "metro-1-east": [{ fromStopId: "a", toStopId: "b", runSeconds: 0, dwellSeconds: 0 }]
      }
    });

    expect(result.success).toBe(false);
  });
});

describe("OpenAPI document", () => {
  it("covers the versioned public contracts", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(Object.keys(openApiDocument.paths)).toContain("/api/v1/vehicles/stream");
    expect(Object.keys(openApiDocument.components.schemas)).toEqual(
      expect.arrayContaining(["TrainSnapshot", "SegmentTimes", "NetworkManifest"])
    );
  });
});

const snapshot = {
  schemaVersion: trainSnapshotSchemaVersion,
  sequence: 3,
  topologyVersion: "fixture-v1",
  feedAt: "2026-09-28T07:30:00.000Z",
  generatedAt: "2026-09-28T07:30:20.000Z",
  lines: [{ lineId: "metro-1", state: "live" }],
  trains: [
    {
      id: "t1",
      lineId: "metro-1",
      patternId: "metro-1-east",
      destinationName: "Château de Vincennes",
      virtualStartAt: "2026-09-28T07:12:00.000Z",
      lastEvidenceAt: "2026-09-28T07:30:00.000Z",
      state: "live",
      stateSince: "2026-09-28T07:14:00.000Z"
    }
  ]
};

describe("trainSnapshotSchema", () => {
  it("accepts timeline trains without coordinates", () => {
    expect(trainSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      trainSnapshotSchema.safeParse({
        ...snapshot,
        feedAt: null,
        lines: [{ lineId: "metro-1", state: "frozen", since: "2026-09-28T07:31:00.000Z" }],
        trains: [{ ...snapshot.trains[0], state: "coasting", holdStopIndex: 4 }]
      }).success
    ).toBe(true);
  });

  it("rejects another schema version and unknown states", () => {
    expect(trainSnapshotSchema.safeParse({ ...snapshot, schemaVersion }).success).toBe(false);
    expect(
      trainSnapshotSchema.safeParse({
        ...snapshot,
        trains: [{ ...snapshot.trains[0], state: "hidden" }]
      }).success
    ).toBe(false);
    expect(
      trainSnapshotSchema.safeParse({
        ...snapshot,
        trains: [{ ...snapshot.trains[0], holdStopIndex: -1 }]
      }).success
    ).toBe(false);
  });
});

describe("serviceStatusSchema", () => {
  it("reports the nightly no-service window", () => {
    expect(
      serviceStatusSchema.safeParse({
        schemaVersion,
        status: "no_service",
        source: "prim",
        generatedAt: "2026-09-28T01:00:00.000Z",
        sourceObservedAt: null,
        sourceAgeSeconds: null,
        pollIntervalSeconds: 120,
        supportedLines: 0,
        message: "No Métro service at this hour"
      }).success
    ).toBe(true);
  });
});
