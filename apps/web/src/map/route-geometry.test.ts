import { describe, expect, it } from "vitest";
import { networkManifestSchema } from "@paris-transit/contracts";
import networkFixture from "../../../../data/paris-metro/network.json";
import type { Coordinate } from "./geo.js";
import {
  buildDisplayLayout,
  pointAlongDisplaySegment,
  renderedLinePaths,
  stationPortKey
} from "./route-geometry.js";

const network = networkManifestSchema.parse(networkFixture);
const layout = buildDisplayLayout(network);

describe("hybrid schematic display geometry", () => {
  it("builds an occurrence-indexed segment for every stop pair without changing source geometry", () => {
    const source = structuredClone(network);

    expect(layout.directions).toHaveLength(
      network.lines.reduce((total, line) => total + line.directions.length, 0)
    );
    for (const line of network.lines) {
      for (const direction of line.directions) {
        const display = layout.directions.get(direction.id);
        expect(display?.segments).toHaveLength(direction.stopIds.length - 1);
        display?.segments.forEach((segment, index) => {
          expect(segment.segmentIndex).toBe(index);
          expect(segment.fromStopId).toBe(direction.stopIds[index]);
          expect(segment.toStopId).toBe(direction.stopIds[index + 1]);
          expect(segment.coordinates[0]).toEqual(
            layout.stationPorts.get(stationPortKey(line.id, segment.fromStopId))
          );
          expect(segment.coordinates.at(-1)).toEqual(
            layout.stationPorts.get(stationPortKey(line.id, segment.toStopId))
          );
          expect(segment.coordinates.every((coordinate) => coordinate.every(Number.isFinite))).toBe(
            true
          );
        });
      }
    }
    expect(network).toEqual(source);
  });

  it("uses one bounded central point with coincident line ports at every interchange", () => {
    const stopById = new Map(network.stops.map((stop) => [stop.id, stop]));

    for (const hub of layout.hubs) {
      const stop = stopById.get(hub.stopId);
      expect(stop).toBeDefined();
      if (!stop) continue;
      expect(distance(hub.center, [stop.longitude, stop.latitude])).toBeLessThanOrEqual(150.1);
      expect(hub.lineCount).toBe(stop.lineIds.length);
      for (const lineId of stop.lineIds) {
        const port = layout.stationPorts.get(stationPortKey(lineId, stop.id));
        expect(port).toBeDefined();
        if (port) expect(samePoint(port, hub.center)).toBe(true);
      }
    }
  });

  it.each(["Bercy", "Invalides", "Michel-Ange - Auteuil", "Michel-Ange - Molitor"])(
    "uses one compact point at the two-line %s hub",
    (name) => {
      const stop = network.stops.find((candidate) => candidate.name === name);
      expect(stop).toBeDefined();
      if (!stop) return;
      const hub = layout.hubs.find((candidate) => candidate.stopId === stop.id);

      expect(stop.lineIds).toHaveLength(2);
      expect(hub?.lineCount).toBe(2);
    }
  );

  it.each([
    "Gare Montparnasse",
    "La Motte-Picquet - Grenelle",
    "Charles de Gaulle - Étoile",
    "Châtelet"
  ])("uses one large-tier point at the %s hub", (name) => {
    const stop = network.stops.find((candidate) => candidate.name === name);
    expect(stop).toBeDefined();
    if (!stop) return;
    const hub = layout.hubs.find((candidate) => candidate.stopId === stop.id);

    expect(stop.lineIds.length).toBeGreaterThanOrEqual(3);
    expect(hub?.lineCount).toBe(stop.lineIds.length);
  });

  it("keeps Line 12 smooth through Montparnasse", () => {
    const stop = network.stops.find((candidate) => candidate.name === "Gare Montparnasse");
    const line = network.lines.find((candidate) => candidate.id === "metro-12");
    expect(stop && line).toBeDefined();
    if (!stop || !line) return;
    let passages = 0;
    for (const direction of line.directions) {
      direction.stopIds.forEach((stopId, index) => {
        if (stopId !== stop.id || index === 0 || index === direction.stopIds.length - 1) return;
        const display = layout.directions.get(direction.id);
        const station = display?.segments[index - 1]?.coordinates.at(-1);
        const before = display?.segments[index - 1]?.coordinates.at(-2);
        const after = display?.segments[index]?.coordinates[1];
        expect(station && before && after).toBeDefined();
        if (!station || !before || !after) return;
        expect(headingDifference(heading(before, station), heading(station, after))).toBeLessThan(
          12
        );
        passages += 1;
      });
    }
    expect(passages).toBeGreaterThan(0);
  });

  it("passes the full-network physical-edge audit", () => {
    const paths = new Map<string, Coordinate[]>();
    const edgeStops = new Map<string, [string, string]>();
    const intentionallySharedEdges = new Set(
      [
        ["Porte d'Auteuil", "Michel-Ange - Molitor"],
        ["Javel", "\u00c9glise d'Auteuil"]
      ].flatMap(([leftName, rightName]) => {
        const left = network.stops.find((stop) => stop.name === leftName);
        const right = network.stops.find((stop) => stop.name === rightName);
        return left && right ? [`metro-10|${[left.id, right.id].sort().join("|")}`] : [];
      })
    );

    for (const direction of layout.directions.values()) {
      for (const segment of direction.segments) {
        const stops = [segment.fromStopId, segment.toStopId].sort();
        const key = `${direction.lineId}|${stops.join("|")}`;
        const coordinates =
          segment.fromStopId < segment.toStopId
            ? segment.coordinates
            : [...segment.coordinates].reverse();
        const existing = paths.get(key);
        if (existing) expect(coordinates).toEqual(existing);
        else {
          paths.set(key, coordinates);
          edgeStops.set(key, [segment.fromStopId, segment.toStopId]);
        }
      }
    }

    expect(network.stops).toHaveLength(321);
    expect(paths.size).toBe(392);
    const intervals = new Map<string, Set<string>>();
    for (const [key, coordinates] of paths) {
      const start = coordinates[0];
      const end = coordinates.at(-1);
      expect(start && end, key).toBeDefined();
      if (!start || !end) continue;
      const progress = coordinates.map((coordinate) => chordProgress(coordinate, start, end));
      if (!intentionallySharedEdges.has(key)) {
        expect(Math.min(...progress), key).toBeGreaterThanOrEqual(-0.006);
        expect(Math.max(...progress), key).toBeLessThanOrEqual(1.006);
        for (let index = 1; index < progress.length; index += 1) {
          expect((progress[index - 1] ?? 0) - (progress[index] ?? 0), key).toBeLessThanOrEqual(
            0.006
          );
        }
      }
      expect(hasSelfIntersection(coordinates), key).toBe(false);
      for (let index = 0; index < coordinates.length - 1; index += 1) {
        const intervalStart = coordinates[index];
        const intervalEnd = coordinates[index + 1];
        if (!intervalStart || !intervalEnd) continue;
        const interval = intervalKey(intervalStart, intervalEnd);
        const lineId = key.split("|")[0] ?? "";
        const owners = intervals.get(`${lineId}|${interval}`) ?? new Set<string>();
        owners.add(key);
        intervals.set(`${lineId}|${interval}`, owners);
      }
    }
    for (const [interval, owners] of intervals) {
      if (owners.size < 2) continue;
      expect(
        [...owners].some((owner) => intentionallySharedEdges.has(owner)),
        `${interval} is shared by ${[...owners].join(", ")}`
      ).toBe(true);
    }

    const entries = [...paths];
    for (const [leftIndex, [leftKey, leftPath]] of entries.entries()) {
      const lineId = leftKey.split("|")[0];
      for (const [rightKey, rightPath] of entries.slice(leftIndex + 1)) {
        if (rightKey.split("|")[0] !== lineId) continue;
        if (intentionallySharedEdges.has(leftKey) || intentionallySharedEdges.has(rightKey)) {
          continue;
        }
        const leftStops = edgeStops.get(leftKey);
        const rightStops = edgeStops.get(rightKey);
        const shareStation = Boolean(
          leftStops && rightStops && leftStops.some((stopId) => rightStops.includes(stopId))
        );
        expect(
          pathsCrossAwayFromSharedStation(leftPath, rightPath, shareStation),
          `${leftKey} crosses ${rightKey}`
        ).toBe(false);
      }
    }

    const rendered = renderedLinePaths(layout);
    const renderedIntervals = rendered.flatMap((path) =>
      path.coordinates.slice(0, -1).flatMap((coordinate, index) => {
        const intervalEnd = path.coordinates[index + 1];
        return intervalEnd ? [`${path.lineId}|${intervalKey(coordinate, intervalEnd)}`] : [];
      })
    );
    expect(new Set(renderedIntervals).size).toBe(renderedIntervals.length);
    expect(new Set(renderedIntervals)).toEqual(new Set(intervals.keys()));
  });

  it("collapses the two extra Line 10 loop strokes onto visible shared corridors", () => {
    const line = network.lines.find((candidate) => candidate.id === "metro-10");
    const porte = network.stops.find((candidate) => candidate.name === "Porte d'Auteuil");
    const boulogne = network.stops.find(
      (candidate) => candidate.name === "Boulogne Jean Jaur\u00e8s"
    );
    const molitor = network.stops.find((candidate) => candidate.name === "Michel-Ange - Molitor");
    const javel = network.stops.find((candidate) => candidate.name === "Javel");
    const mirabeau = network.stops.find((candidate) => candidate.name === "Mirabeau");
    const eglise = network.stops.find((candidate) => candidate.name === "\u00c9glise d'Auteuil");
    expect(line && porte && boulogne && molitor && javel && mirabeau && eglise).toBeDefined();
    if (!line || !porte || !boulogne || !molitor || !javel || !mirabeau || !eglise) return;
    const sourceEdges = new Set<string>();
    const displayEdges = new Set<string>();

    for (const direction of line.directions) {
      direction.stopIds.slice(0, -1).forEach((fromStopId, index) => {
        const toStopId = direction.stopIds[index + 1];
        if (toStopId) sourceEdges.add([fromStopId, toStopId].sort().join("|"));
      });
      for (const segment of layout.directions.get(direction.id)?.segments ?? []) {
        displayEdges.add([segment.fromStopId, segment.toStopId].sort().join("|"));
      }
    }

    expect(displayEdges).toEqual(sourceEdges);
    expect([...displayEdges].some((edge) => edge.includes(mirabeau.id))).toBe(true);
    expect([...displayEdges].some((edge) => edge.includes(eglise.id))).toBe(true);

    const porteMolitor = pathForDisplayEdge(line.id, porte.id, molitor.id);
    const porteBoulogne = pathForDisplayEdge(line.id, porte.id, boulogne.id);
    const boulogneMolitor = pathForDisplayEdge(line.id, boulogne.id, molitor.id);
    expect(porteMolitor).toEqual(joinPaths(porteBoulogne, boulogneMolitor));

    const javelEglise = pathForDisplayEdge(line.id, javel.id, eglise.id);
    const javelMirabeau = pathForDisplayEdge(line.id, javel.id, mirabeau.id);
    expect(javelEglise.slice(0, javelMirabeau.length)).toEqual(javelMirabeau);
    expect(javelEglise.at(-1)).toEqual(layout.stationPorts.get(stationPortKey(line.id, eglise.id)));
  });

  it("keeps every line 7 branch attached to its occurrence-indexed station ports", () => {
    const line = network.lines.find((candidate) => candidate.id === "metro-7");
    expect(line?.directions.length).toBeGreaterThan(2);
    if (!line) return;

    for (const direction of line.directions) {
      const display = layout.directions.get(direction.id);
      expect(display?.segments).toHaveLength(direction.stopIds.length - 1);
      display?.segments.forEach((segment, index) => {
        expect(segment.segmentIndex).toBe(index);
        expect(segment.coordinates[0]).toEqual(
          layout.stationPorts.get(stationPortKey(line.id, segment.fromStopId))
        );
        expect(segment.coordinates.at(-1)).toEqual(
          layout.stationPorts.get(stationPortKey(line.id, segment.toStopId))
        );
      });
    }
  });

  it("uses one clean Line 7 passage through Place d'Italie", () => {
    const stop = network.stops.find((candidate) => candidate.name === "Place d'Italie");
    expect(stop).toBeDefined();
    if (!stop) return;
    const incident = [...layout.directions.values()]
      .filter((direction) => direction.lineId === "metro-7")
      .flatMap((direction) => direction.segments)
      .filter((segment) => segment.fromStopId === stop.id || segment.toStopId === stop.id);
    expect(incident.length).toBeGreaterThan(1);
    for (const segment of incident) {
      const oriented =
        segment.fromStopId === stop.id ? segment.coordinates : [...segment.coordinates].reverse();
      const start = oriented[0];
      const end = oriented.at(-1);
      expect(start && end).toBeDefined();
      if (!start || !end) continue;
      const progress = oriented.map((coordinate) => chordProgress(coordinate, start, end));
      expect(Math.min(...progress)).toBeGreaterThanOrEqual(-0.006);
      expect(Math.max(...progress)).toBeLessThanOrEqual(1.006);
    }
  });

  it("keeps the official route visible when sequential display projection is invalid", () => {
    const invalid = structuredClone(network);
    const direction = invalid.lines[0]?.directions[0];
    expect(direction?.stopIds.length).toBeGreaterThan(1);
    const secondStopId = direction?.stopIds[1];
    if (!direction || !secondStopId) return;
    direction.stopIds = ["missing-stop", secondStopId];
    const official = structuredClone(direction.geometry.coordinates);

    const display = buildDisplayLayout(invalid).directions.get(direction.id);

    expect(display?.coordinates).toEqual(official);
    expect(display?.segments).toHaveLength(0);
  });

  it("keeps docked and moving train points on every canonical display edge", () => {
    for (const display of layout.directions.values()) {
      for (const segment of display.segments) {
        const start = pointAlongDisplaySegment(
          display,
          segment.fromStopId,
          segment.toStopId,
          0,
          segment.segmentIndex
        );
        const middle = pointAlongDisplaySegment(
          display,
          segment.fromStopId,
          segment.toStopId,
          0.5,
          segment.segmentIndex
        );
        const end = pointAlongDisplaySegment(
          display,
          segment.fromStopId,
          segment.toStopId,
          1,
          segment.segmentIndex
        );
        expect([start, middle, end].every(Boolean)).toBe(true);
        expect([start?.longitude, start?.latitude]).toEqual(segment.coordinates[0]);
        expect([end?.longitude, end?.latitude]).toEqual(segment.coordinates.at(-1));
        if (middle) {
          expect(pointOnPath([middle.longitude, middle.latitude], segment.coordinates)).toBe(true);
        }
      }
    }
  });
});

function pathForDisplayEdge(lineId: string, fromStopId: string, toStopId: string): Coordinate[] {
  for (const direction of layout.directions.values()) {
    if (direction.lineId !== lineId) continue;
    const segment = direction.segments.find(
      (candidate) =>
        (candidate.fromStopId === fromStopId && candidate.toStopId === toStopId) ||
        (candidate.fromStopId === toStopId && candidate.toStopId === fromStopId)
    );
    if (!segment) continue;
    return segment.fromStopId === fromStopId
      ? segment.coordinates
      : [...segment.coordinates].reverse();
  }
  return [];
}

function joinPaths(...paths: Coordinate[][]): Coordinate[] {
  const joined: Coordinate[] = [];
  for (const path of paths) {
    for (const coordinate of path) {
      if (!joined.at(-1) || !samePoint(joined.at(-1) ?? coordinate, coordinate)) {
        joined.push(coordinate);
      }
    }
  }
  return joined;
}

function samePoint(left: Coordinate, right: Coordinate): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function distance(left: Coordinate, right: Coordinate): number {
  const radius = 6_371_000;
  const radians = Math.PI / 180;
  const latitudeDelta = (right[1] - left[1]) * radians;
  const longitudeDelta = (right[0] - left[0]) * radians;
  const latitudeLeft = left[1] * radians;
  const latitudeRight = right[1] * radians;
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeLeft) * Math.cos(latitudeRight) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(value));
}

function heading(from: Coordinate, to: Coordinate): number {
  const latitude = ((from[1] + to[1]) / 2) * (Math.PI / 180);
  return (Math.atan2(to[1] - from[1], (to[0] - from[0]) * Math.cos(latitude)) * 180) / Math.PI;
}

function headingDifference(left: number, right: number): number {
  return Math.abs(((left - right + 540) % 360) - 180);
}

function chordProgress(point: Coordinate, start: Coordinate, end: Coordinate): number {
  const scale = Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const deltaX = (end[0] - start[0]) * scale;
  const deltaY = end[1] - start[1];
  const denominator = deltaX ** 2 + deltaY ** 2;
  return denominator === 0
    ? 0
    : ((point[0] - start[0]) * scale * deltaX + (point[1] - start[1]) * deltaY) / denominator;
}

function intervalKey(start: Coordinate, end: Coordinate): string {
  const left = `${start[0].toFixed(9)},${start[1].toFixed(9)}`;
  const right = `${end[0].toFixed(9)},${end[1].toFixed(9)}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function hasSelfIntersection(path: readonly Coordinate[]): boolean {
  for (let left = 0; left < path.length - 1; left += 1) {
    for (let right = left + 2; right < path.length - 1; right += 1) {
      const a = path[left];
      const b = path[left + 1];
      const c = path[right];
      const d = path[right + 1];
      if (a && b && c && d && segmentsCross(a, b, c, d, true)) {
        return true;
      }
    }
  }
  return false;
}

function pathsCrossAwayFromSharedStation(
  left: readonly Coordinate[],
  right: readonly Coordinate[],
  shareStation: boolean
): boolean {
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      const a = left[leftIndex];
      const b = left[leftIndex + 1];
      const c = right[rightIndex];
      const d = right[rightIndex + 1];
      if (a && b && c && d && intervalKey(a, b) === intervalKey(c, d)) continue;
      if (a && b && c && d && segmentsCross(a, b, c, d, shareStation)) {
        return true;
      }
    }
  }
  return false;
}

function segmentsCross(
  a: Coordinate,
  b: Coordinate,
  c: Coordinate,
  d: Coordinate,
  allowSharedEndpoint: boolean
): boolean {
  const values = [turn(a, b, c), turn(a, b, d), turn(c, d, a), turn(c, d, b)];
  const [first, second, third, fourth] = values;
  const epsilon = 1e-14;
  if ((first ?? 0) * (second ?? 0) < -epsilon && (third ?? 0) * (fourth ?? 0) < -epsilon) {
    return true;
  }
  if (values.every((value) => Math.abs(value) <= epsilon) && collinearOverlap(a, b, c, d) > 1e-10) {
    return true;
  }
  const sharedEndpoint = [a, b].some((left) => [c, d].some((right) => samePoint(left, right)));
  if (sharedEndpoint && allowSharedEndpoint) return false;
  return (
    (Math.abs(first ?? 0) <= epsilon && onSegment(c, a, b)) ||
    (Math.abs(second ?? 0) <= epsilon && onSegment(d, a, b)) ||
    (Math.abs(third ?? 0) <= epsilon && onSegment(a, c, d)) ||
    (Math.abs(fourth ?? 0) <= epsilon && onSegment(b, c, d))
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

function turn(a: Coordinate, b: Coordinate, c: Coordinate): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(point: Coordinate, start: Coordinate, end: Coordinate): boolean {
  const epsilon = 1e-10;
  return (
    point[0] >= Math.min(start[0], end[0]) - epsilon &&
    point[0] <= Math.max(start[0], end[0]) + epsilon &&
    point[1] >= Math.min(start[1], end[1]) - epsilon &&
    point[1] <= Math.max(start[1], end[1]) + epsilon
  );
}

function pointOnPath(point: Coordinate, path: readonly Coordinate[]): boolean {
  return path.slice(0, -1).some((start, index) => {
    const end = path[index + 1];
    return end ? Math.abs(turn(start, end, point)) < 1e-12 && onSegment(point, start, end) : false;
  });
}
