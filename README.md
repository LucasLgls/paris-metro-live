# Paris Transit Live

A geographic map of all 16 Paris Métro lines that shows where trains probably are right now,
estimated from live platform countdowns.

**Live:** [paris-transit-live.onrender.com](https://paris-transit-live.onrender.com/)

The Métro's realtime feed, Île-de-France Mobilités PRIM, publishes "next train at platform P in
t seconds" countdowns, not vehicle positions, and its journey ids are not stable train identities.
This project rebuilds trains from those countdowns and animates them along a schematic version of
the official line traces. Positions are always presented as estimates, never as GPS.

## What it shows

- All 16 Métro lines on a quiet map of Paris, in their official colours, with one badge per line.
- Trains gliding at 30 frames per second with an arrow for direction. They never stack, overtake,
  or move backwards.
- Line highlighting on hover or tap, and station labels that appear in tiers as you zoom.
- A status dot for live, degraded, unavailable, or paused-overnight data. When a line's data stops,
  its trains stay where they were, dimmed.
- Reduced motion, keyboard zoom, and a hidden text description of every line and its trains for
  screen readers.

## How it works

```text
PRIM (or offline simulator) ──► server: poll every 120 s, stream-parse, keep Métro countdowns
                                   │
                                   ▼
                         transit-core: countdowns ──► trains (tracked across refreshes)
                                   │
                                   ▼  SSE snapshots
                         browser: place each train on the display network, 30 frames/s
```

1. **Poll.** The server fetches PRIM's global estimated timetable once per provider refresh. The
   response is about 140 MB decoded, so it is stream-parsed and only Métro calls are kept
   (`apps/server/src/sources`).
2. **Place.** Each countdown is projected onto the line's timetable patterns, which gives the time
   the train would have left its origin. Countdowns that agree are clustered into one train, and a
   tracker keeps train identity across refreshes, letting unseen trains coast to the next stop and
   freezing lines when data stops (`packages/transit-core`).
3. **Stream.** Snapshots go to the browser over server-sent events, with polling as a fallback.
4. **Draw.** The browser runs the same placement code to position each train every frame, eases
   corrections so trains never run backwards, and draws them on a canvas over a MapLibre map. The
   display network is derived from the official traces (`apps/web/src/map`).

The full algorithm and its validation targets are in the
[train placement specification](./docs/train-placement.md).

## Repository layout

| Path                     | Contents                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `apps/server`            | Fastify API and SSE stream, PRIM client, ingestion loop, simulator          |
| `apps/web`               | React and MapLibre map, display geometry, train animation, Playwright tests |
| `packages/contracts`     | Shared zod schemas and the OpenAPI document                                 |
| `packages/transit-core`  | Pure train placement logic, shared by the server and the browser            |
| `packages/network-build` | Imports IDFM open data into `data/paris-metro` and validates it             |
| `data/paris-metro`       | The network, timetable segment times, and their provenance                  |
| `docs`                   | Architecture, specifications, runbook, and architecture decisions           |

Built with TypeScript, React, MapLibre GL, Fastify, zod, Vitest, and Playwright.

## Run locally

Requirements: Node 24 and npm 11.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173/`. By default a seeded simulator stands in for PRIM, so no credentials,
Docker, network access, or external map tiles are needed. To use live data, see
[run against live PRIM](./docs/runbook.md#run-against-live-prim).

## Test

```bash
npm run verify     # format, lint, typecheck, unit tests, data validation, build
npm run test:e2e   # Playwright on desktop and mobile, including axe accessibility checks
```

## Documentation

- [Architecture](./docs/architecture.md): components, data flow, API, and failure handling.
- [Train placement](./docs/train-placement.md): the algorithm, its parameters, and validation.
- [Data sources and licensing](./docs/data.md): PRIM, IDFM open data, and the basemap.
- [Runbook](./docs/runbook.md): live PRIM data, the production server, and the network import.
- [Architecture decisions](./docs/adr/): the four decisions that shape the design.
- [Building with agents](./AGENTS.md): how AI agents built and iterated on the project.

## Licence

The code is released under the [MIT licence](./LICENSE). The data keeps its own licences: transit
data from Île-de-France Mobilités (Licence Mobilité and ODbL), and the basemap © OpenStreetMap
contributors (ODbL), via Protomaps. Details are in [data and licensing](./docs/data.md) and on the
app's `/credits` page.
