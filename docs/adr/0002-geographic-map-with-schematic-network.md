# ADR 0002: Geographic map with a generated schematic network

- Status: Accepted
- Date: 2026-09-16

## Context

The map shows all 16 Métro lines on real Paris geography. It must not copy the official network map,
whose licence forbids modified distribution, or depend on a third-party tile service at runtime.
Drawn literally, the official line traces overlap, backtrack near stations, and make simple
interchanges look larger than major hubs, because each line's platforms sit at different points.

## Decision

- **Basemap.** A self-hosted, Paris-only PMTiles extract of OpenStreetMap, built with Protomaps and
  rendered by MapLibre without symbol layers. No runtime tile, glyph, or sprite service is used.
- **Network.** Imported offline from pinned IDFM GTFS and official line traces into
  `data/paris-metro`. The manifest never changes at runtime.
- **Display geometry.** Derived in the browser (`apps/web/src/map`):
  - A line's port at a station is the medoid of its stop projections. At interchanges, every port
    moves to one hub centre: the geometric median of the ports, kept within 150 m of the station.
  - Each stop-to-stop piece of trace is stretched onto its ports, simplified with a 35 m tolerance,
    and rounded with a 45 m radius.
  - Every physical edge gets one path, shared by both directions and chosen by a defect score:
    self-crossings, overshoot, backtracking, and detour.
  - Same-line crossings are redrawn as the smallest conflict-free curve of 40, 80, or 120 m.
  - Two Line 10 service-pattern overlaps are drawn along their passenger-visible corridors.
- **Interaction.** Pan, zoom, and line highlighting only. Stations and trains open no details.

## Alternatives considered

- **A non-geographic schematic.** The first design; replaced because real geography gives the
  network spatial meaning.
- **Exact official traces.** Rejected for the overlaps and misleading interchanges above.
- **A generated octilinear layout.** Built for comparison and rejected in favour of keeping the
  geographic context.

## Consequences

- The drawn network is deliberately less literal than the basemap, but stays within 150 m of the
  real stations.
- Trains move along the same display segments, so they always sit on the drawn lines.
- Geometry tests audit every edge for reversals, overshoot, self-intersection, duplicate intervals,
  and same-line crossings.
