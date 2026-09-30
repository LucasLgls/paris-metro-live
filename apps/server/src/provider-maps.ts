/**
 * Loads the mapping from PRIM line and stop refs to manifest ids. See
 * `config/prim-id-map.example.json` for the format.
 */

import { readFile } from "node:fs/promises";

import type { NetworkManifest } from "@paris-transit/contracts";

/** Provider line and stop refs mapped to manifest ids. Any other sections in the file are ignored. */
export type PrimIdentifierMaps = {
  lineIdMap: Readonly<Record<string, string>>;
  stopIdMap: Readonly<Record<string, string>>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMap(value: unknown, name: string, allowedValues: ReadonlySet<string>) {
  if (!isRecord(value)) throw new Error(`${name} must be a JSON object`);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${name} must not be empty`);
  for (const [providerId, internalId] of entries) {
    if (!providerId || typeof internalId !== "string" || !internalId) {
      throw new Error(`${name} must map non-empty strings to non-empty strings`);
    }
    if (!allowedValues.has(internalId)) {
      throw new Error(`${name} references unknown internal id: ${internalId}`);
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export function parsePrimIdentifierMaps(
  value: unknown,
  manifest: NetworkManifest
): PrimIdentifierMaps {
  if (!isRecord(value)) throw new Error("PRIM identifier mapping must be a JSON object");
  if (value.schemaVersion !== 1) throw new Error("PRIM identifier mapping schemaVersion must be 1");
  return {
    lineIdMap: parseMap(value.lineIds, "lineIds", new Set(manifest.lines.map((line) => line.id))),
    stopIdMap: parseMap(value.stopIds, "stopIds", new Set(manifest.stops.map((stop) => stop.id)))
  };
}

export async function loadPrimIdentifierMaps(
  path: string | undefined,
  manifest: NetworkManifest
): Promise<PrimIdentifierMaps> {
  if (!path) throw new Error("PRIM_ID_MAP_PATH is required when TRANSIT_SOURCE=prim");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsePrimIdentifierMaps(value, manifest);
}
