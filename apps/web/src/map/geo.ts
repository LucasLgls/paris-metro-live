/**
 * Coordinate math for the display network. Coordinates are `[longitude, latitude]` in degrees and
 * distances are metres. Distances and bearings are great-circle; at the scale of Paris, projections
 * and offsets use a local flat-earth approximation, which is accurate to well under a metre.
 */

export type Coordinate = [number, number];

/** A point on a path and the direction of travel there, in degrees clockwise from north. */
export type RoutePoint = {
  longitude: number;
  latitude: number;
  bearing: number;
};

const earthRadiusMeters = 6_371_000;
export const metresPerDegree = (Math.PI * earthRadiusMeters) / 180;
const radians = Math.PI / 180;

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function copyCoordinate(coordinate: Coordinate): Coordinate {
  return [coordinate[0], coordinate[1]];
}

export function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/** Appends a copy of `coordinate` unless it repeats the last point. */
export function appendCoordinate(coordinates: Coordinate[], coordinate: Coordinate) {
  const previous = coordinates.at(-1);
  if (previous?.[0] === coordinate[0] && previous[1] === coordinate[1]) return;
  coordinates.push(copyCoordinate(coordinate));
}

/** Haversine distance. */
export function coordinateDistance(from: Coordinate, to: Coordinate): number {
  const latitudeDelta = (to[1] - from[1]) * radians;
  const longitudeDelta = (to[0] - from[0]) * radians;
  const latitudeA = from[1] * radians;
  const latitudeB = to[1] * radians;
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(value));
}

/** Initial great-circle bearing from `from` to `to`, in [0, 360). */
export function bearing(from: Coordinate, to: Coordinate): number {
  const latitude1 = from[1] * radians;
  const latitude2 = to[1] * radians;
  const longitudeDelta = (to[0] - from[0]) * radians;
  const y = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

export function routeLength(coordinates: readonly Coordinate[]): number {
  return coordinates.slice(1).reduce((total, coordinate, index) => {
    const previous = coordinates[index];
    return previous ? total + coordinateDistance(previous, coordinate) : total;
  }, 0);
}

/** The point `targetDistance` metres along a path, clamped to its ends. */
export function coordinateAtDistance(
  coordinates: readonly Coordinate[],
  targetDistance: number
): RoutePoint | undefined {
  let distanceAlong = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    if (!start || !end) continue;
    const segmentLength = coordinateDistance(start, end);
    if (targetDistance <= distanceAlong + segmentLength || index === coordinates.length - 2) {
      const progress =
        segmentLength === 0 ? 0 : clamp((targetDistance - distanceAlong) / segmentLength);
      const longitude = start[0] + (end[0] - start[0]) * progress;
      const latitude = start[1] + (end[1] - start[1]) * progress;
      return { longitude, latitude, bearing: bearing([longitude, latitude], end) };
    }
    distanceAlong += segmentLength;
  }
  return undefined;
}

/** Destination point `meters` away from `from` along a great circle. */
export function moveAlong(from: Coordinate, bearingDegrees: number, meters: number): Coordinate {
  const angularDistance = meters / earthRadiusMeters;
  const bearingRadians = bearingDegrees * radians;
  const latitude = from[1] * radians;
  const longitude = from[0] * radians;
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearingRadians)
  );
  const targetLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude)
    );
  return [targetLongitude / radians, targetLatitude / radians];
}

/** Moves `meters` from `from` towards `to`, stopping at `to`. */
export function moveBy(from: Coordinate, to: Coordinate, meters: number): Coordinate {
  const distance = coordinateDistance(from, to);
  if (distance === 0 || meters <= 0) return copyCoordinate(from);
  const progress = Math.min(1, meters / distance);
  return [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress];
}

export function moveAtMost(from: Coordinate, to: Coordinate, maximumMeters: number): Coordinate {
  return moveBy(from, to, Math.min(maximumMeters, coordinateDistance(from, to)));
}

/** `origin` shifted by an east/north offset in metres. */
export function localOffset(
  origin: Coordinate,
  xMeters: number,
  yMeters: number,
  referenceLatitude: number
): Coordinate {
  const longitudeScale = Math.cos((referenceLatitude * Math.PI) / 180);
  return [
    origin[0] + xMeters / (metresPerDegree * longitudeScale),
    origin[1] + yMeters / metresPerDegree
  ];
}

export function pointToSegmentDistance(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate
): number {
  const longitudeScale = Math.cos((point[1] * Math.PI) / 180);
  const pointX = point[0] * longitudeScale * metresPerDegree;
  const pointY = point[1] * metresPerDegree;
  const startX = start[0] * longitudeScale * metresPerDegree;
  const startY = start[1] * metresPerDegree;
  const endX = end[0] * longitudeScale * metresPerDegree;
  const endY = end[1] * metresPerDegree;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const denominator = deltaX ** 2 + deltaY ** 2;
  const progress =
    denominator === 0
      ? 0
      : clamp(((pointX - startX) * deltaX + (pointY - startY) * deltaY) / denominator);
  return Math.hypot(pointX - (startX + deltaX * progress), pointY - (startY + deltaY * progress));
}

/** Where `point` projects onto the chord start→end: 0 at start, 1 at end, outside [0, 1] beyond. */
export function chordProgress(point: Coordinate, start: Coordinate, end: Coordinate): number {
  const longitudeScale = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const deltaX = (end[0] - start[0]) * longitudeScale;
  const deltaY = end[1] - start[1];
  const denominator = deltaX ** 2 + deltaY ** 2;
  if (denominator === 0) return 0;
  return (
    ((point[0] - start[0]) * longitudeScale * deltaX + (point[1] - start[1]) * deltaY) / denominator
  );
}

export function quadraticPoint(
  start: Coordinate,
  control: Coordinate,
  end: Coordinate,
  progress: number
): Coordinate {
  const inverse = 1 - progress;
  return [
    inverse * inverse * start[0] +
      2 * inverse * progress * control[0] +
      progress * progress * end[0],
    inverse * inverse * start[1] +
      2 * inverse * progress * control[1] +
      progress * progress * end[1]
  ];
}

/** The input point with the smallest total distance to all the others. */
export function medoid(coordinates: readonly Coordinate[]): Coordinate {
  return copyCoordinate(
    [...coordinates].sort(
      (left, right) =>
        coordinates.reduce((total, coordinate) => total + coordinateDistance(left, coordinate), 0) -
        coordinates.reduce((total, coordinate) => total + coordinateDistance(right, coordinate), 0)
    )[0] ?? [0, 0]
  );
}

/** The point minimising total distance to all inputs (Weiszfeld's algorithm, ≤ 20 iterations). */
export function geometricMedian(coordinates: readonly Coordinate[]): Coordinate {
  if (coordinates.length === 0) return [0, 0];
  let current: Coordinate = [
    coordinates.reduce((total, coordinate) => total + coordinate[0], 0) / coordinates.length,
    coordinates.reduce((total, coordinate) => total + coordinate[1], 0) / coordinates.length
  ];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let longitude = 0;
    let latitude = 0;
    let weightTotal = 0;
    let coincident: Coordinate | undefined;
    for (const coordinate of coordinates) {
      const distance = coordinateDistance(current, coordinate);
      if (distance < 0.01) {
        coincident = coordinate;
        break;
      }
      const weight = 1 / distance;
      longitude += coordinate[0] * weight;
      latitude += coordinate[1] * weight;
      weightTotal += weight;
    }
    if (coincident) return copyCoordinate(coincident);
    const next: Coordinate = [longitude / weightTotal, latitude / weightTotal];
    if (coordinateDistance(current, next) < 0.01) return next;
    current = next;
  }
  return current;
}

/** A direction-independent key for one straight interval, rounded to about 0.1 mm. */
export function coordinateIntervalKey(lineId: string, start: Coordinate, end: Coordinate): string {
  const left = `${start[0].toFixed(9)},${start[1].toFixed(9)}`;
  const right = `${end[0].toFixed(9)},${end[1].toFixed(9)}`;
  return `${lineId}|${left < right ? `${left}|${right}` : `${right}|${left}`}`;
}

/** How many pairs of non-adjacent intervals of a path cross or overlap. A closed loop is allowed. */
export function pathSelfIntersectionCount(coordinates: readonly Coordinate[]): number {
  let count = 0;
  for (let left = 0; left < coordinates.length - 1; left += 1) {
    const a = coordinates[left];
    const b = coordinates[left + 1];
    if (!a || !b) continue;
    for (let right = left + 2; right < coordinates.length - 1; right += 1) {
      if (
        left === 0 &&
        right === coordinates.length - 2 &&
        sameCoordinate(a, coordinates[right + 1] ?? a)
      ) {
        continue;
      }
      const c = coordinates[right];
      const d = coordinates[right + 1];
      if (c && d && segmentsConflict(a, b, c, d)) count += 1;
    }
  }
  return count;
}

/** True when two paths share an interval or any of their intervals cross. */
export function pathsConflict(left: readonly Coordinate[], right: readonly Coordinate[]): boolean {
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    const a = left[leftIndex];
    const b = left[leftIndex + 1];
    if (!a || !b) continue;
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      const c = right[rightIndex];
      const d = right[rightIndex + 1];
      if (!c || !d) continue;
      if (coordinateIntervalKey("", a, b) === coordinateIntervalKey("", c, d)) return true;
      if (segmentsConflict(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Segment intersection with orientation tests: a proper crossing, a collinear overlap, or (unless
 * the segments merely share an endpoint) one segment touching the other.
 */
function segmentsConflict(a: Coordinate, b: Coordinate, c: Coordinate, d: Coordinate): boolean {
  const sharedEndpoint = [a, b].some((left) => [c, d].some((right) => sameCoordinate(left, right)));
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  const epsilon = 1e-14;
  const properCrossing = first * second < -epsilon && third * fourth < -epsilon;
  if (properCrossing) return true;
  if (
    [first, second, third, fourth].every((value) => Math.abs(value) <= epsilon) &&
    collinearOverlap(a, b, c, d) > 1e-10
  ) {
    return true;
  }
  if (sharedEndpoint) return false;
  return (
    (Math.abs(first) <= epsilon && pointOnSegment(c, a, b)) ||
    (Math.abs(second) <= epsilon && pointOnSegment(d, a, b)) ||
    (Math.abs(third) <= epsilon && pointOnSegment(a, c, d)) ||
    (Math.abs(fourth) <= epsilon && pointOnSegment(b, c, d))
  );
}

function collinearOverlap(a: Coordinate, b: Coordinate, c: Coordinate, d: Coordinate): number {
  const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
  return Math.max(
    0,
    Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
  );
}

/** Twice the signed area of triangle abc: > 0 when c is left of a→b. */
function orientation(a: Coordinate, b: Coordinate, c: Coordinate): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point: Coordinate, start: Coordinate, end: Coordinate): boolean {
  const epsilon = 1e-10;
  return (
    point[0] >= Math.min(start[0], end[0]) - epsilon &&
    point[0] <= Math.max(start[0], end[0]) + epsilon &&
    point[1] >= Math.min(start[1], end[1]) - epsilon &&
    point[1] <= Math.max(start[1], end[1]) + epsilon
  );
}
