# Architecture

A modular monolith in one npm-workspaces repository
([ADR 0001](./adr/0001-modular-monolith-with-shared-contracts.md)). One Node process polls the
provider, tracks trains, and serves both the API and the built web app.

```text
PRIM or simulator ──► RealtimeSource ──► ingestion loop ──► TrainTracker ──► in-memory store
                      (apps/server)       (apps/server)      (transit-core)        │
                                                                                   │ REST + SSE
                                                                                   ▼
                     browser: TransitMap ◄── train-motion ◄── transit-core/display ◄┘
                      (apps/web)              (apps/web)       (shared placement code)
```

## Components

| Package                  | Responsibility                                                                |
| ------------------------ | ----------------------------------------------------------------------------- |
| `packages/contracts`     | Zod schemas for every API payload and the generated OpenAPI document          |
| `packages/transit-core`  | Timelines, projection, clustering, and train tracking; pure and deterministic |
| `apps/server`            | PRIM client and simulator, ingestion loop, store, Fastify API, static web app |
| `apps/web`               | React app, MapLibre map, display geometry, per-frame train animation          |
| `packages/network-build` | Imports IDFM GTFS and line traces into `data/paris-metro` and validates them  |

## Data flow

1. **Poll.** The ingestion loop calls `RealtimeSource.poll()` once per provider refresh
   ([ADR 0004](./adr/0004-one-global-prim-request-per-refresh.md)). The PRIM client stream-parses
   the response and returns only platform countdowns: `{ feedAt, predictions[] }`.
2. **Validate.** The loop rejects feeds with the wrong source, impossible timestamps, or bad quota
   metadata before anything reaches the store.
3. **Track.** `TrainTracker` turns countdowns into trains and keeps their identity across refreshes
   ([ADR 0003](./adr/0003-train-placement-from-platform-countdowns.md),
   [specification](./train-placement.md)).
4. **Publish.** Each accepted refresh stores one snapshot and service status. Every subscriber to
   the event stream receives the new snapshot.
5. **Draw.** The browser keeps the latest snapshot. Every frame, it computes each train's position
   with the shared placement code, eases corrections, and places it on the display network
   ([ADR 0002](./adr/0002-geographic-map-with-schematic-network.md)).

A train on the wire is a timeline (`patternId`, `virtualStartAt`, state), never a coordinate, so
motion between refreshes needs no extra traffic and positions are never presented as GPS.

## API

| Endpoint                            | Returns                                          |
| ----------------------------------- | ------------------------------------------------ |
| `GET /api/v1/network/manifest`      | Lines, directions, official traces, and stations |
| `GET /api/v1/network/segment-times` | Median run and dwell times, to build timelines   |
| `GET /api/v1/vehicles`              | The current train snapshot                       |
| `GET /api/v1/vehicles/stream`       | Server-sent events: one snapshot per refresh     |
| `GET /api/v1/status`                | Service status and provider data freshness       |
| `GET /api/v1/openapi.json`          | The OpenAPI 3.1 document                         |
| `GET /health/live`, `/health/ready` | Liveness and readiness                           |
| `GET /metrics`                      | Prometheus request, error, and uptime counters   |

Every response is validated against the shared schemas on both sides. API routes are rate-limited
per client and served with strict security headers.

## Failure handling

- An unchanged provider timestamp is retried once and is not a failure.
- A failed poll, or a feed more than five minutes old, freezes every line: trains stop and are
  dimmed. A line that stops reporting while it has at least three trains freezes on its own. Static
  routes and stations never disappear.
- Status is `healthy` up to five minutes of data age, `degraded` up to ten, then `unavailable`, and
  `no_service` during the nightly pause. The browser falls back from the event stream to polling
  and shows the state in the status dot and its accessible text.

## Testing

- **Unit tests** (Vitest) in every workspace. The placement logic is deterministic, and a seeded
  simulator checks that at least 95% of ground-truth trains are shown within 30 s of their true
  position.
- **Browser tests** (Playwright, desktop and mobile) run the production build against the
  simulator, including axe accessibility checks, reduced motion, outages, and routing.
- **Data validation** checks the network's schema, cross-references, and timings.
