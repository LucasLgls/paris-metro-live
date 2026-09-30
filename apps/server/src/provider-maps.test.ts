import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadNetworkManifest } from "./network-data.js";
import { loadPrimIdentifierMaps, parsePrimIdentifierMaps } from "./provider-maps.js";

describe("PRIM identifier mappings", () => {
  it("loads a non-empty mapping whose targets exist in the network", async () => {
    const manifest = await loadNetworkManifest();
    const path = fileURLToPath(new URL("../config/prim-id-map.example.json", import.meta.url));

    const maps = await loadPrimIdentifierMaps(path, manifest);

    expect(maps.lineIdMap["STIF:Line::C01371:"]).toBe("metro-1");
    expect(maps.stopIdMap["STIF:StopPoint:Q:463193:"]).toBe("idfm-71517");
  });

  it("rejects absent, empty, and unknown mappings", async () => {
    const manifest = await loadNetworkManifest();

    await expect(loadPrimIdentifierMaps(undefined, manifest)).rejects.toThrow("PRIM_ID_MAP_PATH");
    expect(() =>
      parsePrimIdentifierMaps({ schemaVersion: 1, lineIds: {}, stopIds: {} }, manifest)
    ).toThrow("must not be empty");
    expect(() =>
      parsePrimIdentifierMaps(
        { schemaVersion: 1, lineIds: { provider: "unknown-line" }, stopIds: { a: "idfm-71264" } },
        manifest
      )
    ).toThrow("unknown internal id");
  });
});
