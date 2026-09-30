/**
 * Server entry point. Loads the network, picks the realtime source (the offline simulator or PRIM),
 * then starts the ingestion loop and the HTTP server. In production it also serves the built web
 * app from the same origin.
 */

import { buildPatternTimelines, type RealtimeSource } from "@paris-transit/transit-core";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { loadNetworkManifest, loadSegmentTimes, trainLineIds } from "./network-data.js";
import { IngestionLoop } from "./ingestor.js";
import { loadPrimIdentifierMaps } from "./provider-maps.js";
import { FixtureRealtimeSource } from "./sources/fixture-source.js";
import { buildTerminusIndex, PrimRealtimeSource } from "./sources/prim-source.js";
import { InMemoryLiveStore } from "./store.js";

const config = loadRuntimeConfig();
const manifest = await loadNetworkManifest(config.networkManifestPath);
const segmentTimes = await loadSegmentTimes(config.segmentTimesPath);
const timelines = buildPatternTimelines(manifest, segmentTimes);
const webRoot =
  process.env.NODE_ENV === "production"
    ? fileURLToPath(new URL("../../web/dist", import.meta.url))
    : undefined;

async function createSource(): Promise<RealtimeSource> {
  if (config.source === "fixture") {
    return new FixtureRealtimeSource(timelines, trainLineIds(manifest));
  }
  const maps = await loadPrimIdentifierMaps(config.primIdMapPath, manifest);
  return new PrimRealtimeSource({
    apiKey: config.primApiKey,
    baseUrl: config.primApiBaseUrl,
    requestTimeoutMs: config.primRequestTimeoutMs,
    maxCompressedResponseBytes: config.primMaxCompressedResponseBytes,
    maxDecodedResponseBytes: config.primMaxDecodedResponseBytes,
    lineIdMap: maps.lineIdMap,
    stopIdMap: maps.stopIdMap,
    terminusIndex: buildTerminusIndex(manifest)
  });
}

const source = await createSource();
const store = new InMemoryLiveStore();
const app = createApp({
  manifest,
  segmentTimes,
  store,
  source: config.source,
  ...(webRoot ? { webRoot } : {}),
  rateLimitPerMinute: config.rateLimitPerMinute,
  logger: true
});
const ingestion = new IngestionLoop(
  source,
  store,
  manifest,
  timelines,
  config.source === "prim" ? { logger: app.log } : {}
);
await ingestion.start();
await app.listen({ host: config.host, port: config.port });

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  ingestion.stop();
  await app.close();
  await store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
