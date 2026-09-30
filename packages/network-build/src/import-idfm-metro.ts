/**
 * Builds the `paris-metro` network data from pinned IDFM open data: the GTFS timetable and the
 * official Métro line traces. Writes network.json, segment-times.json and provenance.json, and
 * optionally the PRIM identifier map.
 *
 * npm run data:import -- --gtfs <dir> --traces <geojson> --source-timestamp <iso>
 *   [--gtfs-archive <zip>] [--prim-map-output <json>] [--output <dir>]
 *
 * Each direction is one canonical stopping pattern, drawn along the part of the line trace that
 * best fits its stops.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  networkManifestSchema,
  schemaVersion,
  type TransitDirection,
  type TransitLine,
  type TransitStop
} from "@paris-transit/contracts";

import { canonicalJson } from "./json.ts";
import { computeSegmentTimes, parseGtfsTime, type GtfsStopTime } from "./segment-times.ts";
import { validateNetworkReferences } from "./validation.ts";

const expectedCodes = [
  "1",
  "2",
  "3",
  "3B",
  "4",
  "5",
  "6",
  "7",
  "7B",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14"
] as const;

type CsvRow = Record<string, string>;
type RouteRow = {
  routeId: string;
  code: string;
  color: string;
  textColor: string;
};
type TripRow = {
  routeId: string;
  headsign: string;
  shapeId: string;
};
type StopRow = {
  id: string;
  parentId: string;
  name: string;
  longitude: number;
  latitude: number;
};
type Pattern = {
  routeId: string;
  stopIds: string[];
  tripIds: string[];
  headsignCounts: Map<string, number>;
  shapeIds: Set<string>;
};
type TraceFeature = {
  properties: { route_id?: string; route_type?: string };
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
};
type TraceCollection = { features: TraceFeature[] };
type GeometrySelection = {
  coordinates: [number, number][];
  partIndex: number;
  reversed: boolean;
};

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

function requiredArgument(flag: string): string {
  const value = valueAfter(flag);
  if (!value) throw new Error(`${flag} is required`);
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line.charAt(index);
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

/** Streams a GTFS CSV file as rows keyed by header. */
async function* csvRows(path: string): AsyncGenerator<CsvRow> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let headers: string[] | undefined;
  for await (const rawLine of lines) {
    const line = headers ? rawLine : rawLine.replace(/^\uFEFF/, "");
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    yield Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  }
}

async function readRoutes(path: string): Promise<RouteRow[]> {
  const routes: RouteRow[] = [];
  for await (const row of csvRows(path)) {
    if (
      row.route_type !== "1" ||
      !expectedCodes.includes(row.route_short_name as (typeof expectedCodes)[number])
    ) {
      continue;
    }
    routes.push({
      routeId: row.route_id ?? "",
      code: row.route_short_name ?? "",
      color: row.route_color ?? "",
      textColor: row.route_text_color ?? ""
    });
  }
  const counts = new Map<string, number>();
  for (const route of routes) counts.set(route.code, (counts.get(route.code) ?? 0) + 1);
  for (const code of expectedCodes) {
    const count = counts.get(code) ?? 0;
    if (count !== 1)
      throw new Error(`Expected exactly one Métro ${code} route, found ${String(count)}`);
  }
  if (routes.length !== expectedCodes.length) {
    throw new Error(
      `Expected ${String(expectedCodes.length)} Métro routes, found ${String(routes.length)}`
    );
  }
  return routes.sort(
    (left, right) =>
      expectedCodes.indexOf(left.code as (typeof expectedCodes)[number]) -
      expectedCodes.indexOf(right.code as (typeof expectedCodes)[number])
  );
}

async function readTrips(
  path: string,
  routeIds: ReadonlySet<string>
): Promise<Map<string, TripRow>> {
  const trips = new Map<string, TripRow>();
  for await (const row of csvRows(path)) {
    const routeId = row.route_id ?? "";
    const tripId = row.trip_id ?? "";
    if (!routeIds.has(routeId) || !tripId) continue;
    trips.set(tripId, {
      routeId,
      headsign: row.trip_headsign ?? "Unknown destination",
      shapeId: row.shape_id ?? ""
    });
  }
  return trips;
}

async function readStopTimes(
  path: string,
  trips: ReadonlyMap<string, TripRow>
): Promise<Record<string, GtfsStopTime[]>> {
  const byTrip: Record<string, GtfsStopTime[]> = {};
  for await (const row of csvRows(path)) {
    const tripId = row.trip_id ?? "";
    if (!trips.has(tripId)) continue;
    const arrival = row.arrival_time ?? "";
    const departure = row.departure_time ?? "";
    if (!arrival || !departure || !row.stop_id) continue;
    (byTrip[tripId] ??= []).push({
      stopSequence: Number.parseInt(row.stop_sequence ?? "", 10),
      stopId: row.stop_id,
      arrival: parseGtfsTime(arrival),
      departure: parseGtfsTime(departure)
    });
  }
  return byTrip;
}

async function readStops(path: string): Promise<Map<string, StopRow>> {
  const stops = new Map<string, StopRow>();
  for await (const row of csvRows(path)) {
    const id = row.stop_id ?? "";
    if (!id) continue;
    stops.set(id, {
      id,
      parentId: row.parent_station ?? id,
      name: row.stop_name ?? id,
      longitude: Number(row.stop_lon),
      latitude: Number(row.stop_lat)
    });
  }
  return stops;
}

/** Manifest ids are derived from IDFM ids, so they stay stable across imports. */
function stableId(value: string): string {
  return `idfm-${value
    .replace(/^IDFM:/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()}`;
}

function publicCode(code: string): string {
  return code === "3B" ? "3bis" : code === "7B" ? "7bis" : code;
}

function lineId(code: string): string {
  return `metro-${publicCode(code)}`;
}

function sequenceHash(stopIds: readonly string[]): string {
  return createHash("sha256").update(stopIds.join("|")).digest("hex").slice(0, 10);
}

/** Drops consecutive repeats, such as two platforms of one station. */
function collapseAdjacent(values: readonly string[]): string[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

/** True when `candidate` calls at some of `canonical`'s stops, in order, but not all of them. */
function isStrictOrderedSubset(
  candidate: readonly string[],
  canonical: readonly string[]
): boolean {
  if (candidate.length >= canonical.length) return false;
  let index = 0;
  for (const stopId of canonical) {
    if (candidate[index] === stopId) index += 1;
    if (index === candidate.length) return true;
  }
  return false;
}

/**
 * Groups each route's trips by station sequence and keeps the canonical patterns: those that are
 * not a strict ordered subset of another pattern, such as short workings.
 */
function buildPatterns(
  routes: readonly RouteRow[],
  trips: ReadonlyMap<string, TripRow>,
  stopTimesByTrip: Readonly<Record<string, readonly GtfsStopTime[]>>,
  stops: ReadonlyMap<string, StopRow>
): Map<string, Pattern[]> {
  const routeIds = new Set(routes.map((route) => route.routeId));
  const patternMaps = new Map(routes.map((route) => [route.routeId, new Map<string, Pattern>()]));
  for (const [tripId, rows] of Object.entries(stopTimesByTrip)) {
    const trip = trips.get(tripId);
    if (!trip || !routeIds.has(trip.routeId)) continue;
    const parentIds = collapseAdjacent(
      [...rows]
        .sort((left, right) => left.stopSequence - right.stopSequence)
        .map((row) => stops.get(row.stopId)?.parentId)
        .filter((id): id is string => id !== undefined)
    );
    if (parentIds.length < 2) continue;
    const key = parentIds.join("|");
    const patterns = patternMaps.get(trip.routeId);
    if (!patterns) continue;
    const pattern = patterns.get(key) ?? {
      routeId: trip.routeId,
      stopIds: parentIds.map(stableId),
      tripIds: [],
      headsignCounts: new Map<string, number>(),
      shapeIds: new Set<string>()
    };
    pattern.tripIds.push(tripId);
    pattern.headsignCounts.set(trip.headsign, (pattern.headsignCounts.get(trip.headsign) ?? 0) + 1);
    if (trip.shapeId) pattern.shapeIds.add(trip.shapeId);
    patterns.set(key, pattern);
  }

  const result = new Map<string, Pattern[]>();
  for (const route of routes) {
    const patterns = [...(patternMaps.get(route.routeId)?.values() ?? [])];
    const canonical = patterns.filter(
      (candidate) =>
        !patterns.some((other) => isStrictOrderedSubset(candidate.stopIds, other.stopIds))
    );
    if (canonical.length === 0) throw new Error(`No canonical routes found for ${route.code}`);
    result.set(
      route.routeId,
      canonical.sort((left, right) => left.stopIds.join("|").localeCompare(right.stopIds.join("|")))
    );
  }
  return result;
}

function squaredDistance(left: readonly number[], right: readonly number[]): number {
  const longitude = (left[0] ?? 0) - (right[0] ?? 0);
  const latitude = (left[1] ?? 0) - (right[1] ?? 0);
  return longitude * longitude + latitude * latitude;
}

/**
 * How badly a trace fits a pattern (lower is better): the mean squared distance from each stop to
 * the trace, with extra weight on the trace ends, plus one for each stop that falls behind the
 * previous one along the trace.
 */
function geometryScore(
  coordinates: readonly [number, number][],
  stops: readonly StopRow[]
): number {
  const indexes: number[] = [];
  let score = 0;
  for (const stop of stops) {
    const point = [stop.longitude, stop.latitude];
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, coordinate] of coordinates.entries()) {
      const distance = squaredDistance(point, coordinate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    indexes.push(bestIndex);
    score += bestDistance;
  }
  const reversals = indexes.filter(
    (index, position) => position > 0 && index < (indexes[position - 1] ?? 0)
  ).length;
  const firstStop = stops[0];
  const lastStop = stops.at(-1);
  const firstCoordinate = coordinates[0];
  const lastCoordinate = coordinates.at(-1);
  if (firstStop && lastStop && firstCoordinate && lastCoordinate) {
    score += squaredDistance([firstStop.longitude, firstStop.latitude], firstCoordinate) * 2;
    score += squaredDistance([lastStop.longitude, lastStop.latitude], lastCoordinate) * 2;
  }
  return score / Math.max(1, stops.length) + reversals;
}

/** Picks the trace part, and its orientation, that best fits the pattern. */
function selectGeometry(
  parts: readonly [number, number][][],
  patternStops: readonly StopRow[]
): GeometrySelection {
  const candidates = parts.flatMap((coordinates, partIndex) => {
    const reversed = [...coordinates].reverse();
    return [
      { coordinates, partIndex, reversed: false, score: geometryScore(coordinates, patternStops) },
      {
        coordinates: reversed,
        partIndex,
        reversed: true,
        score: geometryScore(reversed, patternStops)
      }
    ];
  });
  const selected = candidates.sort((left, right) => left.score - right.score)[0];
  if (!selected) throw new Error("Official line trace has no geometry parts");
  return {
    coordinates: selected.coordinates.map(([longitude, latitude]) => [longitude, latitude]),
    partIndex: selected.partIndex,
    reversed: selected.reversed
  };
}

function primaryHeadsign(pattern: Pattern): string {
  return (
    [...pattern.headsignCounts.entries()].sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName)
    )[0]?.[0] ?? "Unknown destination"
  );
}

/** The SIRI refs PRIM uses for a GTFS route or platform. */
function providerLineRef(routeId: string): string {
  return `STIF:Line::${routeId.replace(/^IDFM:/, "")}:`;
}

function providerStopRef(stopId: string): string {
  return `STIF:StopPoint:Q:${stopId.replace(/^IDFM:/, "")}:`;
}

function buildPrimMap(
  routes: readonly RouteRow[],
  trips: ReadonlyMap<string, TripRow>,
  stopTimesByTrip: Readonly<Record<string, readonly GtfsStopTime[]>>,
  stops: ReadonlyMap<string, StopRow>
) {
  const lineIds = Object.fromEntries(
    routes.map((route) => [providerLineRef(route.routeId), lineId(route.code)])
  );
  const platformIds = new Set(
    Object.entries(stopTimesByTrip).flatMap(([tripId, rows]) =>
      trips.has(tripId) ? rows.map((row) => row.stopId) : []
    )
  );
  const stopIds = Object.fromEntries(
    [...platformIds].sort().flatMap((platformId) => {
      const stop = stops.get(platformId);
      return stop ? [[providerStopRef(platformId), stableId(stop.parentId)]] : [];
    })
  );
  return { schemaVersion, lineIds, stopIds };
}

/** Line 1 keeps readable direction ids that tests refer to; others are named by stop sequence. */
function directionIdFor(route: RouteRow, pattern: Pattern): string {
  const finalStop = pattern.stopIds.at(-1);
  if (route.code === "1" && finalStop === stableId("IDFM:71634")) return "metro-1-east";
  if (route.code === "1" && finalStop === stableId("IDFM:71517")) return "metro-1-west";
  return `${lineId(route.code)}-pattern-${sequenceHash(pattern.stopIds)}`;
}

async function sha256(path: string): Promise<string> {
  const contents = await readFile(path);
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

const gtfsDirectory = requiredArgument("--gtfs");
const gtfsArchiveValue = valueAfter("--gtfs-archive");
const gtfsArchivePath = gtfsArchiveValue
  ? resolve(process.env.INIT_CWD ?? process.cwd(), gtfsArchiveValue)
  : undefined;
const primMapOutputValue = valueAfter("--prim-map-output");
const primMapOutputPath = primMapOutputValue
  ? resolve(process.env.INIT_CWD ?? process.cwd(), primMapOutputValue)
  : undefined;
const tracesPath = requiredArgument("--traces");
const outputDirectory = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  valueAfter("--output") ?? "data/paris-metro"
);
const sourceTimestamp = new Date(valueAfter("--source-timestamp") ?? "");
if (Number.isNaN(sourceTimestamp.getTime())) {
  throw new Error("--source-timestamp must be a valid ISO date-time");
}

console.log("Reading official Métro routes and trips...");
const routesPath = join(gtfsDirectory, "routes.txt");
const tripsPath = join(gtfsDirectory, "trips.txt");
const stopsPath = join(gtfsDirectory, "stops.txt");
const stopTimesPath = join(gtfsDirectory, "stop_times.txt");
const routes = await readRoutes(routesPath);
const trips = await readTrips(tripsPath, new Set(routes.map((route) => route.routeId)));
console.log(`Reading stop times for ${String(trips.size)} Métro trips...`);
const stopTimesByTrip = await readStopTimes(stopTimesPath, trips);
const sourceStops = await readStops(stopsPath);
const patternsByRoute = buildPatterns(routes, trips, stopTimesByTrip, sourceStops);
const sourceStopsByInternalId = new Map(
  [...sourceStops.values()].map((stop) => [stableId(stop.id), stop])
);

const traces = JSON.parse(await readFile(tracesPath, "utf8")) as TraceCollection;
const tracesByRoute = new Map(
  traces.features
    .filter((feature) => feature.properties.route_type === "Subway")
    .map((feature) => [feature.properties.route_id ?? "", feature.geometry.coordinates])
);
const stopByInternalId = new Map<string, StopRow>();
const lineMemberships = new Map<string, Set<string>>();
const geometryRecords: Record<string, unknown>[] = [];
const lines: TransitLine[] = [];

for (const route of routes) {
  const traceParts = tracesByRoute.get(route.routeId);
  if (!traceParts) throw new Error(`Missing official trace for ${route.routeId}`);
  const directions: TransitDirection[] = [];
  for (const pattern of patternsByRoute.get(route.routeId) ?? []) {
    const sourcePatternStops = pattern.stopIds.map((internalId) => {
      const sourceStop = sourceStopsByInternalId.get(internalId);
      if (!sourceStop) throw new Error(`Missing passenger stop ${internalId}`);
      stopByInternalId.set(internalId, sourceStop);
      const memberships = lineMemberships.get(internalId) ?? new Set<string>();
      memberships.add(lineId(route.code));
      lineMemberships.set(internalId, memberships);
      return sourceStop;
    });
    const geometry = selectGeometry(traceParts, sourcePatternStops);
    const id = directionIdFor(route, pattern);
    directions.push({
      id,
      name: primaryHeadsign(pattern),
      stopIds: pattern.stopIds,
      geometry: {
        type: "LineString",
        coordinates: geometry.coordinates,
        geometrySource: "idfm_line_trace"
      }
    });
    geometryRecords.push({
      directionId: id,
      routeId: route.routeId,
      tracePartIndex: geometry.partIndex,
      traceReversed: geometry.reversed,
      gtfsShapeIds: [...pattern.shapeIds].sort(),
      representativeTripId: pattern.tripIds.sort()[0]
    });
  }
  lines.push({
    id: lineId(route.code),
    code: publicCode(route.code),
    name: `Métro ${publicCode(route.code)}`,
    mode: "metro",
    color: `#${route.color}`,
    textColor: `#${route.textColor}`,
    operator: "RATP",
    capability: "estimated_segment",
    directions
  });
}

const stops: TransitStop[] = [...stopByInternalId.entries()]
  .map(([id, stop]) => ({
    id,
    name: stop.name,
    longitude: stop.longitude,
    latitude: stop.latitude,
    lineIds: [...(lineMemberships.get(id) ?? [])].sort(
      (left, right) =>
        lines.findIndex((line) => line.id === left) - lines.findIndex((line) => line.id === right)
    )
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

const topologyVersion = `paris-metro-${sourceTimestamp.toISOString().slice(0, 10).replaceAll("-", "")}-v1`;
const manifest = networkManifestSchema.parse({
  schemaVersion,
  topologyVersion,
  generatedAt: sourceTimestamp.toISOString(),
  source: "Pinned IDFM GTFS and official line traces",
  attribution:
    "Source: Île-de-France Mobilités Open Data PRIM; timetable and stops: Licence Mobilité; line traces: ODbL; details: /credits",
  lines,
  stops
});
const referenceIssues = validateNetworkReferences(manifest);
if (referenceIssues.length > 0) {
  throw new Error(referenceIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
}

const stopIdByGtfsId = Object.fromEntries(
  [...sourceStops.values()].map((stop) => [stop.id, stableId(stop.parentId)])
);
const segmentTimes = computeSegmentTimes({
  topologyVersion,
  directions: manifest.lines.flatMap((line) => line.directions),
  stopIdByGtfsId,
  stopTimesByTrip
});

const gtfsChecksums = gtfsArchivePath
  ? { archive: await sha256(gtfsArchivePath) }
  : {
      routes: await sha256(routesPath),
      trips: await sha256(tripsPath),
      stops: await sha256(stopsPath),
      stopTimes: await sha256(stopTimesPath)
    };

const provenance = {
  schemaVersion,
  topologyVersion,
  generatedAt: sourceTimestamp.toISOString(),
  rawDownloadsCommitted: false,
  sources: [
    {
      name: "IDFM GTFS",
      localArtifact: basename(gtfsDirectory),
      sourceTimestamp: sourceTimestamp.toISOString(),
      checksums: gtfsChecksums,
      datasetUrl:
        "https://prim.iledefrance-mobilites.fr/jeux-de-donnees/offre-horaires-tc-gtfs-idfm",
      licence: "Licence Mobilité 2.0"
    },
    {
      name: "IDFM official line traces",
      localArtifact: basename(tracesPath),
      sourceTimestamp: sourceTimestamp.toISOString(),
      checksum: await sha256(tracesPath),
      datasetUrl:
        "https://prim.iledefrance-mobilites.fr/fr/jeux-de-donnees/traces-des-lignes-de-transport-en-commun-idfm",
      licence: "ODbL 1.0"
    }
  ],
  routes: routes.map((route) => ({ lineId: lineId(route.code), routeId: route.routeId })),
  geometries: geometryRecords
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "network.json"), canonicalJson(manifest)),
  writeFile(join(outputDirectory, "segment-times.json"), canonicalJson(segmentTimes)),
  writeFile(join(outputDirectory, "provenance.json"), canonicalJson(provenance))
]);
if (primMapOutputPath) {
  const primMap = buildPrimMap(routes, trips, stopTimesByTrip, sourceStops);
  await mkdir(dirname(primMapOutputPath), { recursive: true });
  await writeFile(primMapOutputPath, canonicalJson(primMap));
}
console.log(
  `Wrote ${String(lines.length)} lines, ${String(stops.length)} stations, and ${String(Object.keys(segmentTimes.segments).length)} timed directions to ${outputDirectory}`
);
