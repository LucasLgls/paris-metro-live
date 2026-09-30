/** Loads and validates the static network files, by default the bundled `paris-metro` fixture. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  networkManifestSchema,
  segmentTimesSchema,
  type NetworkManifest,
  type SegmentTimes
} from "@paris-transit/contracts";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function loadNetworkManifest(path?: string): Promise<NetworkManifest> {
  const resolved =
    path ?? fileURLToPath(new URL("../../../data/paris-metro/network.json", import.meta.url));
  return networkManifestSchema.parse(await readJson(resolved));
}

export async function loadSegmentTimes(path?: string): Promise<SegmentTimes> {
  const resolved =
    path ?? fileURLToPath(new URL("../../../data/paris-metro/segment-times.json", import.meta.url));
  return segmentTimesSchema.parse(await readJson(resolved));
}

/** Lines whose trains are placed from live or simulated countdowns. */
export function trainLineIds(manifest: NetworkManifest): string[] {
  return manifest.lines
    .filter((line) => line.capability === "estimated_segment")
    .map((line) => line.id);
}
