/**
 * The HTTP server: the JSON API, the server-sent train stream, health and metrics endpoints, and
 * (in production) the built web app. Adds security headers and a per-IP rate limit on `/api/`.
 */

import { basename, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import {
  schemaVersion,
  trainSnapshotSchemaVersion,
  type NetworkManifest,
  type SegmentTimes,
  type ServiceStatus,
  type TrainSnapshot
} from "@paris-transit/contracts";
import { openApiDocument } from "@paris-transit/contracts/openapi";
import Fastify, { type FastifyInstance } from "fastify";

import type { TransitSourceName } from "./config.js";
import { trainLineIds } from "./network-data.js";
import { providerRefreshMs } from "./ingestor.js";
import { inNightPause } from "./service-hours.js";
import type { LiveStore } from "./store.js";

const healthyUntilSeconds = 300;
const unavailableAfterSeconds = 600;

export type AppOptions = {
  manifest: NetworkManifest;
  segmentTimes: SegmentTimes;
  store: LiveStore;
  source: TransitSourceName;
  webRoot?: string;
  rateLimitPerMinute?: number;
  now?: () => Date;
  logger?: boolean;
};

type Metrics = {
  requests: number;
  errors: number;
  startedAt: number;
};

const apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
const webContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:"
].join("; ");

function servicePath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return (
    path === "/metrics" ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/health" ||
    path.startsWith("/health/")
  );
}

function staticCacheControl(path: string): string {
  const normalized = path.split(sep).join("/");
  if (basename(path) === "index.html") return "no-cache";
  if (normalized.includes("/assets/") || normalized.includes("/maps/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * The public status: the stored status, downgraded by the age of the provider data (fresh up to
 * 5 min, stale up to 10 min, then unavailable). PRIM reports no service during the night pause.
 */
function statusAt(
  status: ServiceStatus | undefined,
  now: Date,
  source: TransitSourceName
): ServiceStatus {
  if (source === "prim" && inNightPause(now)) {
    return {
      schemaVersion,
      status: "no_service",
      source,
      generatedAt: now.toISOString(),
      sourceObservedAt: status?.sourceObservedAt ?? null,
      sourceAgeSeconds: null,
      pollIntervalSeconds: providerRefreshMs / 1000,
      supportedLines: status?.supportedLines ?? 0,
      message: "No Métro service at this hour"
    };
  }
  if (!status) {
    return {
      schemaVersion,
      status: "unavailable",
      source,
      generatedAt: now.toISOString(),
      sourceObservedAt: null,
      sourceAgeSeconds: null,
      pollIntervalSeconds: providerRefreshMs / 1000,
      supportedLines: 0,
      message: "Waiting for the first source update"
    };
  }
  if (status.supportedLines === 0) {
    return {
      ...status,
      status: "unavailable",
      generatedAt: now.toISOString(),
      message: "Realtime source has no usable lines"
    };
  }
  if (!status.sourceObservedAt) return { ...status, generatedAt: now.toISOString() };
  const age = Math.max(0, (now.getTime() - new Date(status.sourceObservedAt).getTime()) / 1000);
  const freshnessStatus =
    age <= healthyUntilSeconds
      ? "healthy"
      : age <= unavailableAfterSeconds
        ? "degraded"
        : "unavailable";
  const severity = { healthy: 0, no_service: 0, degraded: 1, unavailable: 2 } as const;
  const effectiveStatus =
    severity[status.status] > severity[freshnessStatus] ? status.status : freshnessStatus;
  return {
    ...status,
    status: effectiveStatus,
    generatedAt: now.toISOString(),
    sourceAgeSeconds: age,
    message:
      effectiveStatus === status.status
        ? status.message
        : age <= healthyUntilSeconds
          ? "Realtime source is fresh"
          : age <= unavailableAfterSeconds
            ? "Realtime source is stale"
            : "Realtime source is unavailable"
  };
}

export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });
  const now = options.now ?? (() => new Date());
  const metrics: Metrics = { requests: 0, errors: 0, startedAt: Date.now() };
  const rateLimit = options.rateLimitPerMinute ?? 240;
  // Fixed one-minute window per client IP; the table is cleared whenever the window rolls over.
  let rateWindow = -1;
  const requestsByClient = new Map<string, number>();

  app.addHook("onRequest", async (request, reply) => {
    metrics.requests += 1;
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), geolocation=(), microphone=()");
    reply.header(
      "content-security-policy",
      servicePath(request.url) ? apiContentSecurityPolicy : webContentSecurityPolicy
    );
    if (!request.url.startsWith("/api/")) return;
    const minute = Math.floor(now().getTime() / 60_000);
    if (minute !== rateWindow) {
      rateWindow = minute;
      requestsByClient.clear();
    }
    const count = (requestsByClient.get(request.ip) ?? 0) + 1;
    requestsByClient.set(request.ip, count);
    reply.header("x-ratelimit-limit", String(rateLimit));
    reply.header("x-ratelimit-remaining", String(Math.max(0, rateLimit - count)));
    if (count > rateLimit) {
      metrics.errors += 1;
      await reply.code(429).send({ error: "rate_limit_exceeded" });
    }
  });

  if (options.webRoot) {
    void app.register(fastifyStatic, {
      root: options.webRoot,
      index: false,
      setHeaders(response, path) {
        response.header("cache-control", staticCacheControl(path));
      }
    });
    app.get("/", (_request, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .sendFile("index.html")
    );
  }

  app.get("/api/v1/openapi.json", () => openApiDocument);

  app.get("/api/v1/network/manifest", () => options.manifest);

  app.get("/api/v1/network/segment-times", () => options.segmentTimes);

  const lineIds = trainLineIds(options.manifest);
  async function trainSnapshot(): Promise<TrainSnapshot> {
    const generatedAt = now().toISOString();
    const snapshot = await options.store.getSnapshot();
    if (snapshot) return { ...snapshot, generatedAt };
    return {
      schemaVersion: trainSnapshotSchemaVersion,
      sequence: 0,
      topologyVersion: options.manifest.topologyVersion,
      feedAt: null,
      generatedAt,
      lines: lineIds.map((lineId) => ({ lineId, state: "live" as const })),
      trains: []
    };
  }

  app.get("/api/v1/vehicles", trainSnapshot);

  // Server-sent events: the current snapshot, then one per store update. The heartbeat keeps
  // proxies from closing an idle connection. `?once=1` sends a single snapshot and closes.
  app.get<{ Querystring: { once?: string } }>("/api/v1/vehicles/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const send = async () => {
      if (reply.raw.destroyed) return;
      const snapshot = await trainSnapshot();
      reply.raw.write(
        `id: ${String(snapshot.sequence)}\nevent: vehicles\ndata: ${JSON.stringify(snapshot)}\n\n`
      );
    };
    await send();
    if (request.query.once === "1") {
      reply.raw.end();
      return;
    }
    const unsubscribe = await options.store.subscribe(() => void send());
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      void unsubscribe();
    });
  });

  app.get("/api/v1/status", async () =>
    statusAt(await options.store.getStatus(), now(), options.source)
  );
  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const status = statusAt(await options.store.getStatus(), now(), options.source);
    return status.supportedLines === 0
      ? reply.code(503).send({ status: "not_ready" })
      : { status: "ready" };
  });
  app.get("/metrics", (_request, reply) => {
    reply.type("text/plain; version=0.0.4");
    const uptimeSeconds = Math.max(0, (Date.now() - metrics.startedAt) / 1000);
    return [
      "# TYPE paris_transit_http_requests_total counter",
      `paris_transit_http_requests_total ${String(metrics.requests)}`,
      "# TYPE paris_transit_http_errors_total counter",
      `paris_transit_http_errors_total ${String(metrics.errors)}`,
      "# TYPE paris_transit_process_uptime_seconds gauge",
      `paris_transit_process_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
      ""
    ].join("\n");
  });

  // Browser navigations to client-side routes get the app shell; everything else gets a JSON 404.
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (options.webRoot && request.method === "GET" && acceptsHtml && !servicePath(request.url)) {
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return app;
}
