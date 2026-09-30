import { buildPatternTimelines } from "@paris-transit/transit-core";
import { describe, expect, it } from "vitest";

import { loadNetworkManifest, loadSegmentTimes } from "./network-data.js";

describe("fixture loading", () => {
  it("uses the complete 16-line Métro network and its segment times by default", async () => {
    const [network, segmentTimes] = await Promise.all([loadNetworkManifest(), loadSegmentTimes()]);
    const line = network.lines.find((item) => item.id === "metro-1");

    expect(network.lines).toHaveLength(16);
    expect(network.stops).toHaveLength(321);
    expect(line?.directions[0]?.stopIds).toHaveLength(25);
    expect(line?.directions[0]?.geometry.coordinates.length).toBeGreaterThan(100);
    expect(buildPatternTimelines(network, segmentTimes)).toHaveLength(37);
  });
});
