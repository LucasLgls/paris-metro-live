/**
 * Builds the network drawn on the map from the official line traces.
 *
 * Each direction's stops are projected in order onto its trace. A line's port at a station is the
 * medoid of those projections across its directions. Where several lines share a station, their
 * ports merge into one hub centre: the geometric median of the ports, kept within 150 m of the
 * real station. Each stop-to-stop piece of trace is then cut out, stretched onto its ports,
 * simplified and rounded.
 *
 * Finally, both directions of a line share one path per edge, same-line paths that cross are
 * redrawn as curves, and two Line 10 service-pattern overlaps are collapsed (ADR 0002). A direction
 * that can't be placed falls back to its raw trace.
 */

import type { NetworkManifest, TransitDirection, TransitStop } from "@paris-transit/contracts";
import {
  appendCoordinate,
  chordProgress,
  clamp,
  coordinateAtDistance,
  coordinateDistance,
  coordinateIntervalKey,
  copyCoordinate,
  geometricMedian,
  medoid,
  moveAtMost,
  pathSelfIntersectionCount,
  pathsConflict,
  routeLength,
  sameCoordinate,
  type Coordinate,
  type RoutePoint
} from "./geo.js";
import {
  curvedPath,
  deformPath,
  nearestProjection,
  projectionsOnRoute,
  roundCorners,
  simplifyPath,
  sliceRoute,
  smoothStationPassages,
  type Projection
} from "./path-shaping.js";

/** The drawn path between two consecutive stops of one direction. */
export type DisplaySegment = {
  segmentIndex: number;
  fromStopId: string;
  toStopId: string;
  coordinates: Coordinate[];
};

/** One direction of a line as drawn, cut into stop-to-stop segments. */
export type DisplayDirection = {
  id: string;
  lineId: string;
  name: string;
  stopIds: string[];
  coordinates: Coordinate[];
  segments: DisplaySegment[];
};

/** A station served by several lines, drawn as one dot where their tracks meet. */
export type StationHub = {
  stopId: string;
  center: Coordinate;
  lineCount: number;
};

/** Everything the map draws. `stationPorts` is keyed by {@link stationPortKey}. */
export type DisplayLayout = {
  directions: Map<string, DisplayDirection>;
  stationCoordinates: Map<string, Coordinate>;
  stationPorts: Map<string, Coordinate>;
  hubs: StationHub[];
};

/** A run of one line's track to draw. */
export type DisplayLinePath = {
  lineId: string;
  coordinates: Coordinate[];
};

const generalizationToleranceMeters = 35;
const maximumCornerRadiusMeters = 45;
const maximumHubCenterDisplacementMeters = 150;
const pathProgressTolerance = 0.005;
const maximumDisplayDetourRatio = 2.5;
const conflictOffsetsMeters = [40, -40, 80, -80, 120, -120] as const;
/** Edges drawn through their via stations instead of as a separate stroke (ADR 0002). */
const sharedDisplayCorridors = [
  {
    lineId: "metro-10",
    fromStopName: "Porte d'Auteuil",
    viaStopNames: ["Boulogne Jean Jaur\u00e8s"],
    toStopName: "Michel-Ange - Molitor"
  },
  {
    lineId: "metro-10",
    fromStopName: "Javel",
    viaStopNames: ["Mirabeau"],
    toStopName: "\u00c9glise d'Auteuil"
  }
] as const;

/** Key of the point where one line's track meets a station. */
export function stationPortKey(lineId: string, stopId: string): string {
  return `${lineId}|${stopId}`;
}

/** Builds the display network for a manifest; see the module comment for the steps. */
export function buildDisplayLayout(manifest: NetworkManifest): DisplayLayout {
  const stopById = new Map(manifest.stops.map((stop) => [stop.id, stop]));
  const projectionsByDirection = new Map<string, Projection[]>();
  const portCandidates = new Map<string, Coordinate[]>();

  for (const line of manifest.lines) {
    for (const direction of line.directions) {
      const projections = sequentialStopProjections(direction, stopById);
      if (!projections) continue;
      projectionsByDirection.set(direction.id, projections);
      projections.forEach((projection, index) => {
        const stopId = direction.stopIds[index];
        if (!stopId) return;
        const key = stationPortKey(line.id, stopId);
        const candidates = portCandidates.get(key) ?? [];
        candidates.push(projection.coordinate);
        portCandidates.set(key, candidates);
      });
    }
  }

  const sourcePorts = new Map<string, Coordinate>();
  for (const [key, candidates] of portCandidates) {
    sourcePorts.set(key, medoid(candidates));
  }
  for (const stop of manifest.stops) {
    for (const lineId of stop.lineIds) {
      const key = stationPortKey(lineId, stop.id);
      if (!sourcePorts.has(key)) sourcePorts.set(key, [stop.longitude, stop.latitude]);
    }
  }

  const stationPorts = new Map(sourcePorts);
  const hubs: StationHub[] = [];
  for (const stop of manifest.stops.filter((candidate) => candidate.lineIds.length > 1)) {
    const original = [stop.longitude, stop.latitude] as Coordinate;
    const source = stop.lineIds.flatMap((lineId) => {
      const coordinate = sourcePorts.get(stationPortKey(lineId, stop.id));
      return coordinate ? [{ lineId, coordinate }] : [];
    });
    if (source.length < 2) continue;
    const unconstrainedCenter = geometricMedian(source.map((port) => port.coordinate));
    const center = moveAtMost(original, unconstrainedCenter, maximumHubCenterDisplacementMeters);
    const ports = source.map((port) => ({
      lineId: port.lineId,
      coordinate: copyCoordinate(center)
    }));
    for (const port of ports) {
      stationPorts.set(stationPortKey(port.lineId, stop.id), port.coordinate);
    }
    hubs.push({ stopId: stop.id, center, lineCount: ports.length });
  }

  const directions = new Map<string, DisplayDirection>();
  for (const line of manifest.lines) {
    for (const direction of line.directions) {
      const projections = projectionsByDirection.get(direction.id);
      if (!projections) {
        directions.set(direction.id, sourceDisplayDirection(line.id, direction, stopById));
        continue;
      }
      const segments: DisplaySegment[] = [];
      for (let index = 0; index < direction.stopIds.length - 1; index += 1) {
        const fromStopId = direction.stopIds[index];
        const toStopId = direction.stopIds[index + 1];
        if (!fromStopId || !toStopId) continue;
        const fromPort =
          stationPorts.get(stationPortKey(line.id, fromStopId)) ??
          coordinateForStop(stopById.get(fromStopId));
        const toPort =
          stationPorts.get(stationPortKey(line.id, toStopId)) ??
          coordinateForStop(stopById.get(toStopId));
        if (!fromPort || !toPort) continue;
        const fromProjection = projections[index];
        const toProjection = projections[index + 1];
        const sourcePath =
          fromProjection && toProjection
            ? sliceRoute(direction.geometry.coordinates, fromProjection, toProjection)
            : [fromPort, toPort];
        const deformed = deformPath(sourcePath, fromPort, toPort);
        const simplified = simplifyPath(deformed, generalizationToleranceMeters);
        segments.push({
          segmentIndex: index,
          fromStopId,
          toStopId,
          coordinates: simplified.length > 1 ? simplified : [fromPort, toPort]
        });
      }
      const displaySegments = smoothStationPassages(segments, maximumCornerRadiusMeters).map(
        (segment) => ({
          ...segment,
          coordinates: roundCorners(segment.coordinates, maximumCornerRadiusMeters)
        })
      );
      if (
        displaySegments.length !== direction.stopIds.length - 1 ||
        displaySegments.some(
          (segment) =>
            segment.coordinates.length < 2 ||
            segment.coordinates.some((coordinate) => !coordinate.every(Number.isFinite))
        )
      ) {
        directions.set(direction.id, sourceDisplayDirection(line.id, direction, stopById));
        continue;
      }
      const coordinates: Coordinate[] = [];
      for (const segment of displaySegments) {
        for (const coordinate of segment.coordinates) appendCoordinate(coordinates, coordinate);
      }
      directions.set(direction.id, {
        id: direction.id,
        lineId: line.id,
        name: direction.name,
        stopIds: [...direction.stopIds],
        coordinates:
          coordinates.length > 1
            ? coordinates
            : direction.geometry.coordinates.map((coordinate) => [coordinate[0], coordinate[1]]),
        segments: displaySegments
      });
    }
  }

  canonicalizeDisplayEdges(manifest, directions);

  const hubByStopId = new Map(hubs.map((hub) => [hub.stopId, hub]));
  const stationCoordinates = new Map(
    manifest.stops.map((stop) => {
      const hub = hubByStopId.get(stop.id);
      const coordinate =
        hub?.center ??
        stationPorts.get(stationPortKey(stop.lineIds[0] ?? "", stop.id)) ??
        ([stop.longitude, stop.latitude] as Coordinate);
      return [stop.id, coordinate] as const;
    })
  );

  return { directions, stationCoordinates, stationPorts, hubs };
}

/** Makes both directions of a line reuse one path per edge: the least defective candidate. */
function canonicalizeDisplayEdges(
  manifest: NetworkManifest,
  directions: Map<string, DisplayDirection>
): void {
  const candidates = new Map<string, Coordinate[][]>();

  for (const line of manifest.lines) {
    for (const direction of line.directions) {
      const display = directions.get(direction.id);
      if (!display) continue;
      for (const segment of display.segments) {
        const key = displayEdgeKey(line.id, segment.fromStopId, segment.toStopId);
        const coordinates =
          segment.fromStopId < segment.toStopId
            ? segment.coordinates
            : [...segment.coordinates].reverse();
        const paths = candidates.get(key) ?? [];
        paths.push(coordinates.map(copyCoordinate));
        candidates.set(key, paths);
      }
    }
  }

  const paths = new Map<string, Coordinate[]>();
  const pathScores = new Map<string, number[]>();
  for (const [key, available] of [...candidates].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const selected = [...available].sort(comparePathCandidates)[0];
    if (!selected) continue;
    paths.set(key, cleanDisplayPath(selected));
    pathScores.set(key, pathDefectScore(selected));
  }
  resolveSameLineConflicts(paths, pathScores);
  collapseSharedDisplayCorridors(manifest, paths);

  for (const line of manifest.lines) {
    for (const direction of line.directions) {
      const display = directions.get(direction.id);
      if (!display || display.segments.length === 0) continue;
      const segments = display.segments.map((segment) => {
        const path = paths.get(displayEdgeKey(line.id, segment.fromStopId, segment.toStopId));
        if (!path) return segment;
        const coordinates = segment.fromStopId < segment.toStopId ? path : [...path].reverse();
        return { ...segment, coordinates: coordinates.map(copyCoordinate) };
      });
      const coordinates: Coordinate[] = [];
      for (const segment of segments) {
        for (const coordinate of segment.coordinates) appendCoordinate(coordinates, coordinate);
      }
      directions.set(direction.id, { ...display, segments, coordinates });
    }
  }
}

/** Replaces each {@link sharedDisplayCorridors} edge with the path through its via stops. */
function collapseSharedDisplayCorridors(
  manifest: NetworkManifest,
  paths: Map<string, Coordinate[]>
): void {
  for (const rule of sharedDisplayCorridors) {
    const stopIds = [rule.fromStopName, ...rule.viaStopNames, rule.toStopName].map(
      (name) =>
        manifest.stops.find((stop) => stop.name === name && stop.lineIds.includes(rule.lineId))?.id
    );
    const fromStopId = stopIds[0];
    const toStopId = stopIds.at(-1);
    if (!fromStopId || !toStopId || stopIds.some((stopId) => !stopId)) continue;
    const original = orientedDisplayPath(paths, rule.lineId, fromStopId, toStopId);
    const originalStart = original?.[0];
    const originalEnd = original?.at(-1);
    if (!originalStart || !originalEnd) continue;

    const collapsed: Coordinate[] = [];
    for (let index = 0; index < stopIds.length - 1; index += 1) {
      const from = stopIds[index];
      const to = stopIds[index + 1];
      if (!from || !to) break;
      const shared = orientedDisplayPath(paths, rule.lineId, from, to);
      const fallbackStart = collapsed.at(-1) ?? originalStart;
      const path =
        shared ?? (index === stopIds.length - 2 ? [fallbackStart, originalEnd] : undefined);
      if (!path?.[0] || !path.at(-1)) break;
      for (const coordinate of path) appendCoordinate(collapsed, coordinate);
    }
    if (
      collapsed.length < 2 ||
      !sameCoordinate(collapsed[0] ?? [0, 0], originalStart) ||
      !sameCoordinate(collapsed.at(-1) ?? [0, 0], originalEnd)
    ) {
      continue;
    }
    paths.set(
      displayEdgeKey(rule.lineId, fromStopId, toStopId),
      fromStopId < toStopId ? collapsed : [...collapsed].reverse()
    );
  }
}

/** A copy of an edge's stored path, oriented from → to. Paths are stored in stop-id order. */
function orientedDisplayPath(
  paths: ReadonlyMap<string, Coordinate[]>,
  lineId: string,
  fromStopId: string,
  toStopId: string
): Coordinate[] | undefined {
  const path = paths.get(displayEdgeKey(lineId, fromStopId, toStopId));
  if (!path) return undefined;
  const oriented = fromStopId < toStopId ? path : [...path].reverse();
  return oriented.map(copyCoordinate);
}

/** Splits the layout into strokes to draw, skipping intervals an earlier stroke already covers. */
export function renderedLinePaths(layout: DisplayLayout): DisplayLinePath[] {
  const seenEdges = new Set<string>();
  const seenIntervals = new Set<string>();
  const paths: DisplayLinePath[] = [];

  for (const direction of layout.directions.values()) {
    for (const segment of direction.segments) {
      const edgeKey = displayEdgeKey(direction.lineId, segment.fromStopId, segment.toStopId);
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      let run: Coordinate[] = [];
      for (let index = 0; index < segment.coordinates.length - 1; index += 1) {
        const start = segment.coordinates[index];
        const end = segment.coordinates[index + 1];
        if (!start || !end) continue;
        const intervalKey = coordinateIntervalKey(direction.lineId, start, end);
        if (seenIntervals.has(intervalKey)) {
          if (run.length > 1) paths.push({ lineId: direction.lineId, coordinates: run });
          run = [];
          continue;
        }
        seenIntervals.add(intervalKey);
        if (run.length === 0) run.push(copyCoordinate(start));
        appendCoordinate(run, end);
      }
      if (run.length > 1) paths.push({ lineId: direction.lineId, coordinates: run });
    }
  }
  return paths;
}

/** Orders paths by defect score, then by content so the choice is deterministic. */
function comparePathCandidates(left: Coordinate[], right: Coordinate[]): number {
  const leftScore = pathDefectScore(left);
  const rightScore = pathDefectScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

/**
 * Defects compared in order, lower is better: self-crossings, overshoot past either end,
 * backtracking along the chord, and detour ratio.
 */
function pathDefectScore(coordinates: readonly Coordinate[]): number[] {
  const start = coordinates[0];
  const end = coordinates.at(-1);
  if (!start || !end || coordinates.length < 2) return [1, 1, 1, Number.POSITIVE_INFINITY];
  const progress = coordinates.map((coordinate) => chordProgress(coordinate, start, end));
  let reversal = 0;
  let overshoot = 0;
  for (let index = 0; index < progress.length; index += 1) {
    const current = progress[index] ?? 0;
    const previous = progress[index - 1];
    overshoot += Math.max(0, -current, current - 1);
    if (previous !== undefined) reversal += Math.max(0, previous - current);
  }
  const chordLength = coordinateDistance(start, end);
  const detour =
    chordLength === 0 ? Number.POSITIVE_INFINITY : routeLength(coordinates) / chordLength;
  return [pathSelfIntersectionCount(coordinates), overshoot, reversal, detour];
}

/**
 * Drops points that overshoot either end or backtrack along the chord. Falls back to a straight
 * line if the result still crosses itself or detours too far.
 */
function cleanDisplayPath(coordinates: readonly Coordinate[]): Coordinate[] {
  const start = coordinates[0];
  const end = coordinates.at(-1);
  if (!start || !end || coordinates.length < 2 || sameCoordinate(start, end)) {
    return start && end ? [copyCoordinate(start), copyCoordinate(end)] : [];
  }
  const cleaned: Coordinate[] = [copyCoordinate(start)];
  let lastProgress = 0;
  for (const coordinate of coordinates.slice(1, -1)) {
    const progress = chordProgress(coordinate, start, end);
    if (progress < -pathProgressTolerance || progress > 1 + pathProgressTolerance) continue;
    if (progress + pathProgressTolerance < lastProgress) continue;
    appendCoordinate(cleaned, coordinate);
    lastProgress = Math.max(lastProgress, progress);
  }
  appendCoordinate(cleaned, end);
  const chordLength = coordinateDistance(start, end);
  if (
    cleaned.length < 2 ||
    pathSelfIntersectionCount(cleaned) > 0 ||
    chordLength === 0 ||
    routeLength(cleaned) / chordLength > maximumDisplayDetourRatio
  ) {
    return [copyCoordinate(start), copyCoordinate(end)];
  }
  return cleaned;
}

/**
 * Accepts each line's paths best-first. A path that crosses or overlaps an accepted one becomes the
 * first bowed curve that doesn't, or else a straight line.
 */
function resolveSameLineConflicts(
  paths: Map<string, Coordinate[]>,
  pathScores: ReadonlyMap<string, number[]>
): void {
  const acceptedByLine = new Map<string, Coordinate[][]>();
  const orderedPaths = [...paths].sort(([leftKey], [rightKey]) => {
    const lineDifference = (leftKey.split("|")[0] ?? "").localeCompare(
      rightKey.split("|")[0] ?? ""
    );
    if (lineDifference !== 0) return lineDifference;
    const leftScore = pathScores.get(leftKey) ?? [];
    const rightScore = pathScores.get(rightKey) ?? [];
    for (let index = 0; index < Math.max(leftScore.length, rightScore.length); index += 1) {
      const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return leftKey.localeCompare(rightKey);
  });
  for (const [key, path] of orderedPaths) {
    const lineId = key.split("|")[0] ?? "";
    const accepted = acceptedByLine.get(lineId) ?? [];
    if (!accepted.some((candidate) => pathsConflict(path, candidate))) {
      accepted.push(path);
      acceptedByLine.set(lineId, accepted);
      continue;
    }
    const replacement = conflictOffsetsMeters
      .map((offset) => curvedPath(path[0], path.at(-1), offset))
      .find(
        (candidate) =>
          candidate.length > 1 &&
          pathSelfIntersectionCount(candidate) === 0 &&
          !accepted.some((existing) => pathsConflict(candidate, existing))
      );
    const resolved = replacement ?? [
      copyCoordinate(path[0] ?? [0, 0]),
      copyCoordinate(path.at(-1) ?? [0, 0])
    ];
    paths.set(key, resolved);
    accepted.push(resolved);
    acceptedByLine.set(lineId, accepted);
  }
}

/** A direction-independent key for the edge between two stops of a line. */
function displayEdgeKey(lineId: string, leftStopId: string, rightStopId: string): string {
  return `${lineId}|${
    leftStopId < rightStopId ? `${leftStopId}|${rightStopId}` : `${rightStopId}|${leftStopId}`
  }`;
}

/** Fallback: the raw trace, cut at each stop's nearest projection. */
function sourceDisplayDirection(
  lineId: string,
  direction: TransitDirection,
  stopById: ReadonlyMap<string, TransitStop>
): DisplayDirection {
  const coordinates = direction.geometry.coordinates.map(copyCoordinate);
  const segments = direction.stopIds.slice(0, -1).flatMap((fromStopId, segmentIndex) => {
    const toStopId = direction.stopIds[segmentIndex + 1];
    const fromStop = stopById.get(fromStopId);
    const toStop = toStopId ? stopById.get(toStopId) : undefined;
    if (!toStopId || !fromStop || !toStop || coordinates.length < 2) return [];
    const from = nearestProjection(coordinates, fromStop.longitude, fromStop.latitude);
    const to = nearestProjection(coordinates, toStop.longitude, toStop.latitude);
    const sourcePath = sliceRoute(coordinates, from, to);
    return [
      {
        segmentIndex,
        fromStopId,
        toStopId,
        coordinates: sourcePath.length > 1 ? sourcePath : [from.coordinate, to.coordinate]
      }
    ];
  });
  return {
    id: direction.id,
    lineId,
    name: direction.name,
    stopIds: [...direction.stopIds],
    coordinates,
    segments
  };
}

/**
 * The point at `progress` (0–1) along the drawn segment between two stops. Pass `segmentIndex` when
 * the stop pair occurs more than once in the direction; an ambiguous pair returns undefined.
 */
export function pointAlongDisplaySegment(
  direction: DisplayDirection,
  fromStopId: string,
  toStopId: string,
  progress: number,
  segmentIndex?: number
): RoutePoint | undefined {
  const matches = direction.segments.filter(
    (segment) => segment.fromStopId === fromStopId && segment.toStopId === toStopId
  );
  const segment =
    segmentIndex === undefined
      ? matches.length === 1
        ? matches[0]
        : undefined
      : direction.segments[segmentIndex];
  if (!segment || segment.fromStopId !== fromStopId || segment.toStopId !== toStopId) {
    return undefined;
  }
  return coordinateAtDistance(
    segment.coordinates,
    routeLength(segment.coordinates) * clamp(progress)
  );
}

function coordinateForStop(stop: TransitStop | undefined): Coordinate | undefined {
  return stop ? [stop.longitude, stop.latitude] : undefined;
}

/**
 * Projects each stop onto the trace strictly after the previous one, so a trace that passes a stop
 * twice uses the pass in stop order. Undefined if any stop can't be placed.
 */
function sequentialStopProjections(
  direction: TransitDirection,
  stopById: ReadonlyMap<string, TransitStop>
): Projection[] | undefined {
  const selected: Projection[] = [];
  for (const stopId of direction.stopIds) {
    const stop = stopById.get(stopId);
    if (!stop) return undefined;
    const previousDistance = selected.at(-1)?.distanceAlong ?? -1;
    const projection = projectionsOnRoute(
      direction.geometry.coordinates,
      stop.longitude,
      stop.latitude
    )
      .filter((candidate) => candidate.distanceAlong > previousDistance + 0.5)
      .sort((left, right) => left.squaredDistance - right.squaredDistance)[0];
    if (!projection) return undefined;
    selected.push(projection);
  }
  return selected;
}
