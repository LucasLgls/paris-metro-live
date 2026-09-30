import { describe, expect, it } from "vitest";
import type { NetworkManifest, SegmentTimes } from "@paris-transit/contracts";
import { validateNetworkReferences, validateSegmentTimes } from "./validation.ts";

const network: NetworkManifest = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  generatedAt: "2026-08-31T12:00:00.000Z",
  source: "synthetic",
  attribution: "Test data",
  lines: [
    {
      id: "line:1",
      code: "1",
      name: "Test line",
      mode: "metro",
      color: "#000000",
      textColor: "#FFFFFF",
      operator: "Test",
      capability: "estimated_segment",
      directions: [
        {
          id: "outbound",
          name: "Outbound",
          stopIds: ["stop:a", "stop:b"],
          geometry: {
            type: "LineString",
            coordinates: [
              [2.3, 48.8],
              [2.4, 48.9]
            ]
          }
        }
      ]
    }
  ],
  stops: [
    { id: "stop:a", name: "A", longitude: 2.3, latitude: 48.8, lineIds: ["line:1"] },
    { id: "stop:b", name: "B", longitude: 2.4, latitude: 48.9, lineIds: ["line:1"] }
  ]
};

const segmentTimes: SegmentTimes = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  segments: {
    outbound: [{ fromStopId: "stop:a", toStopId: "stop:b", runSeconds: 90, dwellSeconds: 20 }]
  }
};

describe("fixture validation", () => {
  it("accepts connected network references and complete segment times", () => {
    expect(validateNetworkReferences(network)).toEqual([]);
    expect(validateSegmentTimes(network, segmentTimes)).toEqual([]);
  });

  it("reports a direction without timing for every segment", () => {
    expect(
      validateSegmentTimes(network, { ...segmentTimes, segments: { outbound: [] } })
    ).toContainEqual({ path: "segment-times.outbound", message: "Incomplete segment timing" });
  });

  it("reports unknown stops", () => {
    const broken = structuredClone(network);
    broken.lines[0]?.directions[0]?.stopIds.push("stop:missing");
    expect(validateNetworkReferences(broken)).toContainEqual({
      path: "lines.0.directions.0.stopIds",
      message: "Unknown stop id: stop:missing"
    });
  });
});
