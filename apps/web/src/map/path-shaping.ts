/**
 * Operations on one path, used to turn an official line trace into a display path: project stations
 * onto it, cut it between stations, stretch the cut to fit the display station points, simplify it,
 * and round its corners.
 */

import {
  appendCoordinate,
  bearing,
  clamp,
  coordinateAtDistance,
  coordinateDistance,
  copyCoordinate,
  localOffset,
  metresPerDegree,
  moveAlong,
  moveBy,
  pointToSegmentDistance,
  quadraticPoint,
  routeLength,
  sameCoordinate,
  type Coordinate
} from "./geo.js";

/** Where a point lands on a route: the nearest point of one of its intervals. */
export type Projection = {
  coordinate: Coordinate;
  distanceAlong: number;
  segmentIndex: number;
  segmentProgress: number;
  squaredDistance: number;
};

/** The projection of a point onto every interval of a route, in route order. */
export function projectionsOnRoute(
  coordinates: readonly Coordinate[],
  longitude: number,
  latitude: number
): Projection[] {
  const longitudeScale = Math.cos((latitude * Math.PI) / 180);
  const projections: Projection[] = [];
  let distanceAlong = 0;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    if (!start || !end) continue;
    const deltaLongitude = (end[0] - start[0]) * longitudeScale;
    const deltaLatitude = end[1] - start[1];
    const lengthSquared = deltaLongitude ** 2 + deltaLatitude ** 2;
    const raw =
      lengthSquared === 0
        ? 0
        : ((longitude - start[0]) * longitudeScale * deltaLongitude +
            (latitude - start[1]) * deltaLatitude) /
          lengthSquared;
    const segmentProgress = clamp(raw);
    const coordinate: Coordinate = [
      start[0] + (end[0] - start[0]) * segmentProgress,
      start[1] + (end[1] - start[1]) * segmentProgress
    ];
    const squaredDistance =
      ((longitude - coordinate[0]) * longitudeScale) ** 2 + (latitude - coordinate[1]) ** 2;
    const segmentLength = coordinateDistance(start, end);
    projections.push({
      coordinate,
      distanceAlong: distanceAlong + segmentLength * segmentProgress,
      segmentIndex: index,
      segmentProgress,
      squaredDistance
    });
    distanceAlong += segmentLength;
  }
  return projections;
}

export function nearestProjection(
  coordinates: readonly Coordinate[],
  longitude: number,
  latitude: number
): Projection {
  return (
    projectionsOnRoute(coordinates, longitude, latitude).sort(
      (left, right) => left.squaredDistance - right.squaredDistance
    )[0] ?? {
      coordinate: coordinates[0] ?? [longitude, latitude],
      distanceAlong: 0,
      segmentIndex: 0,
      segmentProgress: 0,
      squaredDistance: 0
    }
  );
}

/** The part of a route between two projections. */
export function sliceRoute(
  coordinates: readonly Coordinate[],
  from: Projection,
  to: Projection
): Coordinate[] {
  if (to.distanceAlong <= from.distanceAlong) return [from.coordinate, to.coordinate];
  const output: Coordinate[] = [from.coordinate];
  for (let index = from.segmentIndex + 1; index <= to.segmentIndex; index += 1) {
    const coordinate = coordinates[index];
    if (coordinate) appendCoordinate(output, coordinate);
  }
  appendCoordinate(output, to.coordinate);
  return output;
}

/**
 * Moves a path's ends onto `from` and `to`, spreading the shift along the path in proportion to
 * distance travelled so its shape is kept.
 */
export function deformPath(
  coordinates: readonly Coordinate[],
  from: Coordinate,
  to: Coordinate
): Coordinate[] {
  const start = coordinates[0] ?? from;
  const end = coordinates.at(-1) ?? to;
  const total = routeLength(coordinates);
  let travelled = 0;
  return coordinates.map((coordinate, index) => {
    if (index > 0)
      travelled += coordinateDistance(coordinates[index - 1] ?? coordinate, coordinate);
    const progress = total === 0 ? index / Math.max(1, coordinates.length - 1) : travelled / total;
    return [
      coordinate[0] + (from[0] - start[0]) * (1 - progress) + (to[0] - end[0]) * progress,
      coordinate[1] + (from[1] - start[1]) * (1 - progress) + (to[1] - end[1]) * progress
    ];
  });
}

/** Douglas–Peucker simplification, iterative to avoid deep recursion on long traces. */
export function simplifyPath(
  coordinates: readonly Coordinate[],
  toleranceMeters: number
): Coordinate[] {
  if (coordinates.length <= 2) return coordinates.map(copyCoordinate);
  const keep = new Set([0, coordinates.length - 1]);
  const ranges: [number, number][] = [[0, coordinates.length - 1]];
  while (ranges.length > 0) {
    const range = ranges.pop();
    if (!range) continue;
    const [startIndex, endIndex] = range;
    const start = coordinates[startIndex];
    const end = coordinates[endIndex];
    if (!start || !end) continue;
    let maximumDistance = 0;
    let selectedIndex = -1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const coordinate = coordinates[index];
      if (!coordinate) continue;
      const distance = pointToSegmentDistance(coordinate, start, end);
      if (distance > maximumDistance) {
        maximumDistance = distance;
        selectedIndex = index;
      }
    }
    if (selectedIndex >= 0 && maximumDistance > toleranceMeters) {
      keep.add(selectedIndex);
      ranges.push([startIndex, selectedIndex], [selectedIndex, endIndex]);
    }
  }
  return [...keep]
    .sort((left, right) => left - right)
    .flatMap((index) => (coordinates[index] ? [copyCoordinate(coordinates[index])] : []));
}

/**
 * Replaces each interior corner with a short quadratic Bézier. The radius never exceeds a quarter of
 * either neighbouring interval, so short zig-zags stay intact.
 */
export function roundCorners(
  coordinates: readonly Coordinate[],
  radiusMeters: number
): Coordinate[] {
  if (coordinates.length <= 2) return coordinates.map(copyCoordinate);
  const output: Coordinate[] = [copyCoordinate(coordinates[0] ?? [0, 0])];
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const previous = coordinates[index - 1];
    const corner = coordinates[index];
    const next = coordinates[index + 1];
    if (!previous || !corner || !next) continue;
    const incoming = coordinateDistance(previous, corner);
    const outgoing = coordinateDistance(corner, next);
    const radius = Math.min(radiusMeters, incoming * 0.25, outgoing * 0.25);
    if (radius < 1) {
      appendCoordinate(output, corner);
      continue;
    }
    const before = moveBy(corner, previous, radius);
    const after = moveBy(corner, next, radius);
    appendCoordinate(output, before);
    for (const progress of [0.25, 0.5, 0.75]) {
      appendCoordinate(output, quadraticPoint(before, corner, after, progress));
    }
    appendCoordinate(output, after);
  }
  appendCoordinate(output, coordinates.at(-1) ?? [0, 0]);
  return output;
}

/**
 * Makes consecutive segments pass straight through their shared station: both approaches are bent
 * onto one tangent there, so a line never shows a kink exactly at a station dot.
 */
export function smoothStationPassages<T extends { coordinates: Coordinate[] }>(
  segments: readonly T[],
  radiusMeters: number
): T[] {
  const output = segments.map((segment) => ({
    ...segment,
    coordinates: segment.coordinates.map(copyCoordinate)
  }));
  for (let index = 1; index < output.length; index += 1) {
    const incoming = output[index - 1];
    const outgoing = output[index];
    const station = incoming?.coordinates.at(-1);
    const outgoingStart = outgoing?.coordinates[0];
    if (
      !incoming ||
      !outgoing ||
      !station ||
      !outgoingStart ||
      !sameCoordinate(station, outgoingStart)
    ) {
      continue;
    }
    const incomingLength = routeLength(incoming.coordinates);
    const outgoingLength = routeLength(outgoing.coordinates);
    const radius = Math.min(radiusMeters, incomingLength * 0.2, outgoingLength * 0.2);
    if (radius < 1) continue;
    const before = coordinateAtDistance(incoming.coordinates, Math.max(0, incomingLength - radius));
    const after = coordinateAtDistance(outgoing.coordinates, radius);
    if (!before || !after) continue;
    const tangent = throughTangent([before.longitude, before.latitude], station, [
      after.longitude,
      after.latitude
    ]);
    const incomingHandle = moveAlong(station, tangent + 180, radius);
    const outgoingHandle = moveAlong(station, tangent, radius);
    incoming.coordinates = replaceEndApproach(
      incoming.coordinates,
      incomingHandle,
      station,
      radius
    );
    outgoing.coordinates = replaceStartApproach(
      outgoing.coordinates,
      station,
      outgoingHandle,
      radius
    );
  }
  return output;
}

/** The bearing halfway between arriving at and leaving `station`. */
function throughTangent(before: Coordinate, station: Coordinate, after: Coordinate): number {
  const incoming = bearing(before, station);
  const outgoing = bearing(station, after);
  const incomingX = Math.sin((incoming * Math.PI) / 180);
  const incomingY = Math.cos((incoming * Math.PI) / 180);
  const outgoingX = Math.sin((outgoing * Math.PI) / 180);
  const outgoingY = Math.cos((outgoing * Math.PI) / 180);
  const x = incomingX + outgoingX;
  const y = incomingY + outgoingY;
  if (Math.hypot(x, y) < 0.01) return outgoing;
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function replaceEndApproach(
  coordinates: readonly Coordinate[],
  handle: Coordinate,
  endpoint: Coordinate,
  radius: number
): Coordinate[] {
  const threshold = radius * 1.25;
  let keepThrough = coordinates.length - 2;
  while (
    keepThrough > 0 &&
    coordinateDistance(coordinates[keepThrough] ?? endpoint, endpoint) <= threshold
  ) {
    keepThrough -= 1;
  }
  return [
    ...coordinates.slice(0, keepThrough + 1).map(copyCoordinate),
    handle,
    copyCoordinate(endpoint)
  ];
}

function replaceStartApproach(
  coordinates: readonly Coordinate[],
  endpoint: Coordinate,
  handle: Coordinate,
  radius: number
): Coordinate[] {
  const threshold = radius * 1.25;
  let keepFrom = 1;
  while (
    keepFrom < coordinates.length - 1 &&
    coordinateDistance(coordinates[keepFrom] ?? endpoint, endpoint) <= threshold
  ) {
    keepFrom += 1;
  }
  return [copyCoordinate(endpoint), handle, ...coordinates.slice(keepFrom).map(copyCoordinate)];
}

/** A 13-point cubic Bézier from `start` to `end`, bowed sideways by `offsetMeters`. */
export function curvedPath(
  start: Coordinate | undefined,
  end: Coordinate | undefined,
  offsetMeters: number
): Coordinate[] {
  if (!start || !end) return [];
  const midpointLatitude = (start[1] + end[1]) / 2;
  const longitudeScale = Math.cos((midpointLatitude * Math.PI) / 180);
  const deltaX = (end[0] - start[0]) * longitudeScale * metresPerDegree;
  const deltaY = (end[1] - start[1]) * metresPerDegree;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return [copyCoordinate(start), copyCoordinate(end)];
  const offsetX = (-deltaY / length) * offsetMeters;
  const offsetY = (deltaX / length) * offsetMeters;
  const controlA = localOffset(start, deltaX / 3 + offsetX, deltaY / 3 + offsetY, midpointLatitude);
  const controlB = localOffset(
    start,
    (deltaX * 2) / 3 + offsetX,
    (deltaY * 2) / 3 + offsetY,
    midpointLatitude
  );
  const output: Coordinate[] = [];
  for (let step = 0; step <= 12; step += 1) {
    const progress = step / 12;
    const inverse = 1 - progress;
    output.push([
      inverse ** 3 * start[0] +
        3 * inverse ** 2 * progress * controlA[0] +
        3 * inverse * progress ** 2 * controlB[0] +
        progress ** 3 * end[0],
      inverse ** 3 * start[1] +
        3 * inverse ** 2 * progress * controlA[1] +
        3 * inverse * progress ** 2 * controlB[1] +
        progress ** 3 * end[1]
    ]);
  }
  return output;
}
