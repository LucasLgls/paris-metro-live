# Runbook

## Run locally

```bash
npm ci
npm run dev
```

Open `http://localhost:5173/`. A seeded simulator stands in for PRIM, so no credentials, Docker,
network access, or external map tiles are needed.

## Run the production server

Build the web app, then start the single same-origin server:

```bash
npm run build -w @paris-transit/web
NODE_ENV=production TRANSIT_SOURCE=fixture PORT=3001 npm run start -w @paris-transit/server
```

Open `http://localhost:3001/`. One process serves the app, `/credits`, the map tiles, the API, the
event stream, health, and metrics.

## Run against live PRIM

Live data needs a [PRIM](https://prim.iledefrance-mobilites.fr/) API key and the identifier map that
`npm run data:import` writes with `--prim-map-output`. Put them in `apps/server/.env`, a
git-ignored copy of `apps/server/.env.example`:

```dotenv
PRIM_API_KEY=your-key
TRANSIT_SOURCE=prim
PRIM_ID_MAP_PATH=config/prim-id-map.json
```

The path is relative to `apps/server`. `apps/server/config/prim-id-map.example.json` shows the
map's format, and [ADR 0004](./adr/0004-one-global-prim-request-per-refresh.md) describes the
polling. Never commit the API key, the identifier map, or raw PRIM responses.

## Import the Métro network

Download the IDFM GTFS archive and the official line traces into the git-ignored
`data/downloads/`, extract the archive, then run:

```bash
npm run data:import -- --gtfs <extracted-gtfs> --gtfs-archive <gtfs.zip> --traces <line-traces.geojson> --source-timestamp <ISO-8601> --prim-map-output apps/server/config/prim-id-map.json
npm run data:validate
```

The import fails if an expected line is missing or duplicated. It rewrites the three JSON files in
`data/paris-metro`, which are reviewed like code.

## Verify changes

```bash
npm run verify     # format, lint, typecheck, unit tests, data validation, build
npm run test:e2e   # browser tests against the production build
```

If port 5173 is taken, set another for the browser tests: `E2E_WEB_PORT=35175 npm run test:e2e`.
