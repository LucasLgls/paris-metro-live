import {
  networkManifestSchema,
  segmentTimesSchema,
  serviceStatusSchema,
  trainSnapshotSchema
} from "@paris-transit/contracts";
import { buildPatternTimelines } from "@paris-transit/transit-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "./app.js";
import { loadNetworkManifest, loadSegmentTimes, trainLineIds } from "./network-data.js";
import { IngestionLoop } from "./ingestor.js";
import { FixtureRealtimeSource } from "./sources/fixture-source.js";
import { InMemoryLiveStore } from "./store.js";

const openApps: ReturnType<typeof createApp>[] = [];
let webRoot: string;

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "paris-transit-web-"));
  await Promise.all([
    mkdir(join(webRoot, "assets")),
    mkdir(join(webRoot, "maps")),
    writeFile(join(webRoot, "index.html"), "<!doctype html><title>Paris Transit Live</title>")
  ]);
  await Promise.all([
    writeFile(join(webRoot, "assets", "index-test.js"), "console.log('test');"),
    writeFile(join(webRoot, "maps", "paris-test.pmtiles"), Buffer.from("0123456789"))
  ]);
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function fixtureApp(
  options: { rateLimitPerMinute?: number; ageSeconds?: number; webRoot?: string } = {}
) {
  const manifest = await loadNetworkManifest();
  const segmentTimes = await loadSegmentTimes();
  const timelines = buildPatternTimelines(manifest, segmentTimes);
  const sourceAt = new Date("2026-08-31T12:00:00.000Z");
  const store = new InMemoryLiveStore();
  const clock = () => sourceAt;
  const loop = new IngestionLoop(
    new FixtureRealtimeSource(timelines, trainLineIds(manifest), clock),
    store,
    manifest,
    timelines,
    { clock }
  );
  await loop.start();
  loop.stop();
  const app = createApp({
    manifest,
    segmentTimes,
    store,
    source: "fixture",
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.rateLimitPerMinute === undefined
      ? {}
      : { rateLimitPerMinute: options.rateLimitPerMinute }),
    now: () => new Date(sourceAt.getTime() + (options.ageSeconds ?? 0) * 1000)
  });
  openApps.push(app);
  return { app, manifest, store };
}

describe("fixture API", () => {
  it("serves contract-valid network, segment times, trains, and status", async () => {
    const { app } = await fixtureApp();
    const [network, segmentTimes, trains, status] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/network/manifest" }),
      app.inject({ method: "GET", url: "/api/v1/network/segment-times" }),
      app.inject({ method: "GET", url: "/api/v1/vehicles" }),
      app.inject({ method: "GET", url: "/api/v1/status" })
    ]);

    networkManifestSchema.parse(network.json());
    expect(Object.keys(segmentTimesSchema.parse(segmentTimes.json()).segments)).toHaveLength(37);
    const snapshot = trainSnapshotSchema.parse(trains.json());
    expect(snapshot.feedAt).toBe("2026-08-31T12:00:00.000Z");
    expect(snapshot.lines).toHaveLength(16);
    expect(snapshot.trains.length).toBeGreaterThan(100);
    expect(JSON.stringify(snapshot)).not.toMatch(/longitude|latitude/);
    expect(serviceStatusSchema.parse(status.json())).toMatchObject({
      status: "healthy",
      pollIntervalSeconds: 120,
      supportedLines: 16
    });
  });

  it("serves the read-only OpenAPI document", async () => {
    const { app } = await fixtureApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths).toHaveProperty("/api/v1/vehicles/stream");
    expect(document.paths).toHaveProperty("/api/v1/network/segment-times");
  });

  it("serves the production web app with SPA fallback and separate browser security headers", async () => {
    const { app } = await fixtureApp({ webRoot });

    const [root, credits, api, missingApi] = await Promise.all([
      app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } }),
      app.inject({ method: "GET", url: "/credits", headers: { accept: "text/html" } }),
      app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { accept: "text/html" }
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/missing",
        headers: { accept: "text/html" }
      })
    ]);

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("Paris Transit Live");
    expect(root.headers["cache-control"]).toBe("no-cache");
    expect(root.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(credits.statusCode).toBe(200);
    expect(credits.body).toBe(root.body);
    serviceStatusSchema.parse(api.json());
    expect(api.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "not_found" });
  });

  it("serves immutable assets and PMTiles byte ranges", async () => {
    const { app } = await fixtureApp({ webRoot });

    const [asset, range] = await Promise.all([
      app.inject({ method: "GET", url: "/assets/index-test.js" }),
      app.inject({
        method: "GET",
        url: "/maps/paris-test.pmtiles",
        headers: { range: "bytes=2-5" }
      })
    ]);

    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(range.statusCode).toBe(206);
    expect(range.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(range.headers["content-range"]).toBe("bytes 2-5/10");
    expect(range.body).toBe("2345");
  });

  it("supports one-shot SSE and polling with equivalent sequence numbers", async () => {
    const { app } = await fixtureApp();
    const polling = await app.inject({ method: "GET", url: "/api/v1/vehicles" });
    const stream = await app.inject({ method: "GET", url: "/api/v1/vehicles/stream?once=1" });

    const parsedPolling = trainSnapshotSchema.parse(polling.json());
    expect(parsedPolling.sequence).toBe(1);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain(`id: ${String(parsedPolling.sequence)}`);
    expect(stream.body).toContain("event: vehicles");
  });

  it("keeps the data 0–5 minutes old healthy, then degraded, then unavailable", async () => {
    const statusAt = async (ageSeconds: number) => {
      const { app } = await fixtureApp({ ageSeconds });
      const response = await app.inject({ method: "GET", url: "/api/v1/status" });
      return serviceStatusSchema.parse(response.json());
    };

    expect((await statusAt(300)).status).toBe("healthy");
    expect(await statusAt(301)).toMatchObject({
      status: "degraded",
      message: "Realtime source is stale"
    });
    expect((await statusAt(601)).status).toBe("unavailable");
  });

  it("stays ready with stale data once initialized", async () => {
    const { app } = await fixtureApp({ ageSeconds: 601 });

    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(ready.statusCode).toBe(200);
  });

  it("preserves a recovered status message until the next ingestion", async () => {
    const { app, store } = await fixtureApp();
    const status = await store.getStatus();
    if (!status) throw new Error("Fixture status was not initialized");
    await store.setStatus({ ...status, message: "Realtime source recovered" });

    const response = await app.inject({ method: "GET", url: "/api/v1/status" });

    expect(serviceStatusSchema.parse(response.json()).message).toBe("Realtime source recovered");
  });

  it("is not ready when the source has zero usable lines", async () => {
    const { app, store } = await fixtureApp();
    const status = await store.getStatus();
    if (!status) throw new Error("Fixture status was not initialized");
    await store.setStatus({
      ...status,
      status: "healthy",
      supportedLines: 0,
      message: "Upstream request succeeded"
    });

    const [reportedStatus, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/status" }),
      app.inject({ method: "GET", url: "/health/ready" })
    ]);

    expect(serviceStatusSchema.parse(reportedStatus.json()).status).toBe("unavailable");
    expect(ready.statusCode).toBe(503);
  });

  it("is not ready before the first ingestion and serves an empty snapshot", async () => {
    const manifest = await loadNetworkManifest();
    const app = createApp({
      manifest,
      segmentTimes: await loadSegmentTimes(),
      store: new InMemoryLiveStore(),
      source: "fixture"
    });
    openApps.push(app);

    const [ready, trains] = await Promise.all([
      app.inject({ method: "GET", url: "/health/ready" }),
      app.inject({ method: "GET", url: "/api/v1/vehicles" })
    ]);

    expect(ready.statusCode).toBe(503);
    expect(trainSnapshotSchema.parse(trains.json())).toMatchObject({ feedAt: null, trains: [] });
  });

  it("reports no Métro service during the PRIM night pause", async () => {
    const manifest = await loadNetworkManifest();
    const app = createApp({
      manifest,
      segmentTimes: await loadSegmentTimes(),
      store: new InMemoryLiveStore(),
      source: "prim",
      // 03:00 in Paris (CEST).
      now: () => new Date("2026-09-28T01:00:00.000Z")
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/status" });

    expect(serviceStatusSchema.parse(response.json())).toMatchObject({
      status: "no_service",
      message: "No Métro service at this hour"
    });
  });

  it("returns useful not-found errors and enforces the request limit", async () => {
    const { app } = await fixtureApp({ rateLimitPerMinute: 2 });
    const missing = await app.inject({ method: "GET", url: "/api/v1/lines/missing/live" });
    await app.inject({ method: "GET", url: "/api/v1/network/manifest" });
    const limited = await app.inject({ method: "GET", url: "/api/v1/network/manifest" });

    expect(missing.statusCode).toBe(404);
    expect(limited.statusCode).toBe(429);
  });
});
