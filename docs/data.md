# Data sources and licensing

## Realtime: PRIM

Île-de-France Mobilités PRIM "Prochains passages — Requête globale" (`estimated-timetable`) provides
planned and expected passage times, not vehicle positions. Expected times are informed by the
operator's vehicle positions, but the response does not disclose them.

- RATP journey identifiers are technical counters, not trains, so they are ignored and every call is
  used as a platform countdown ([ADR 0003](./adr/0003-train-placement-from-platform-countdowns.md)).
- `DirectionRef` is ignored. `DestinationRef`, or failing that `DestinationDisplay`, selects the
  branch.
- The response covers 30 minutes before the request to two hours after it.
- The response timestamp advances every 120 s. The default quota is 1,000 global requests a day,
  or 1,500 after an approved increase. Polling is described in
  [ADR 0004](./adr/0004-one-global-prim-request-per-refresh.md).
- The per-stop `stop-monitoring` endpoint exposes `VehicleAtStop`, but still no actual times or
  coordinates, and covering the network with it would far exceed the quota.

## Static network: IDFM GTFS and line traces

The IDFM GTFS provides stops, lines, and timetables; the official IDFM line-trace dataset provides
the route geometry. Both are pinned and imported offline into `data/paris-metro`
([runbook](./runbook.md#import-the-métro-network)). `provenance.json` records the source timestamp,
checksums, route ids, and which trace part each direction uses. Raw downloads are never committed.

`segment-times.json` holds the median run and dwell time of every stop-to-stop segment, computed
from GTFS `stop_times`. The server and the browser build the same pattern timelines from it.

## Basemap

`apps/web/public/maps/paris-metro-20260909.pmtiles` was extracted with PMTiles CLI 1.31.2 from the
2026-09-09 Protomaps planet build, with bounds `2.15,48.65,2.55,49.08` and zooms 9–14. It is
14,794,171 bytes with SHA-256
`2AB9EB4BCB0B43809034D85E7D78DA3A8C75F8F582FD239912DA5BD0FF5F1A91`. Symbol layers are removed, so no
glyph or sprite service is needed.

## Licences

This is an engineering record, not legal advice.

| Source                    | Terms                                                                                                          | Obligations                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| IDFM GTFS                 | [Licence Mobilité](https://prim.iledefrance-mobilites.fr/fr/licences)                                          | Attribute IDFM, use registered access, keep the licence on equivalent derived databases. |
| IDFM official line traces | [ODbL](https://prim.iledefrance-mobilites.fr/fr/jeux-de-donnees/traces-des-lignes-de-transport-en-commun-idfm) | Attribute, and share the transformed geometry alike.                                     |
| PRIM estimated timetable  | Licence Mobilité; [API terms: ODbL](https://prim.iledefrance-mobilites.fr/fr/apis/idfm-ivtr-requete_globale)   | Registered, quota-respecting access; both sets of conditions apply.                      |
| OpenStreetMap data        | [ODbL 1.0](https://www.openstreetmap.org/copyright)                                                            | Visible, linked attribution.                                                             |
| ESA WorldCover land cover | [CC BY 4.0](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md)                                   | ESA WorldCover attribution, shown on `/credits`.                                         |
| Paris PMTiles extract     | [ODbL Produced Work](https://docs.protomaps.com/basemaps/downloads)                                            | Keep visible OpenStreetMap attribution.                                                  |
| `@protomaps/basemaps`     | [BSD-3-Clause; visual design CC0](https://github.com/protomaps/basemaps#licensing-and-attribution-guidelines)  | Retain software notices.                                                                 |
| `pmtiles`, `maplibre-gl`  | BSD-3-Clause                                                                                                   | Retain copyright notices.                                                                |

- The app does not copy an IDFM or RATP network map, whose CC BY-NC-ND licence forbids modified
  distribution.
- Realtime responses are processed in memory. Public output contains short-lived estimates, never
  raw PRIM responses, provider journey ids, or a historical database.
- The transformed network is published at `/api/v1/network/manifest`.
- The map keeps a linked `© OpenStreetMap contributors` notice visible, and `/credits` lists every
  source, its terms, and the fact that train positions are estimates, not GPS.
