# ADR 0001: Modular monolith with shared contracts

- Status: Accepted
- Date: 2026-09-01

## Context

The app has one realtime provider and one map client, and it must run fully offline for development
and tests. The server and the browser have to agree on the shape of the API and on where each train
is.

## Decision

- One npm-workspaces repository:
  - `packages/contracts`: zod schemas are the executable source of truth for the API, and the
    OpenAPI 3.1 document is generated from them.
  - `packages/transit-core`: pure train placement logic with no runtime, provider, or storage code.
    The browser imports only its `display` entry point.
  - `apps/server`: Fastify, provider adapters behind `RealtimeSource`, the ingestion loop, an
    in-memory store, and the REST and server-sent-events API.
  - `apps/web`: React and MapLibre. It imports only the contracts and `transit-core/display`.
  - `packages/network-build`: the offline importer and validator for the network data.
- Dependencies point inward, towards the contracts and transit-core. Lint rules enforce the browser
  and transit-core boundaries.
- One process serves the built web app and the API from one origin, keeps live state in memory, and
  runs one ingestion loop. There is no database, cache, or object storage.
- A seeded simulator implements `RealtimeSource`, so development and tests need no credentials or
  network access.

## Consequences

- The server and the browser place trains with the same code, so they cannot drift apart.
- Invalid data fails schema validation at the boundary instead of reaching the interface.
- Exactly one instance may run. A restart loses live state, which rebuilds at the first poll.
  Horizontal scaling would need shared state and is deferred until load requires it.
- Changing a schema is an API change and needs a new ADR.
