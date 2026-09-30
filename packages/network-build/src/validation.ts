/** Reference and timing checks shared by the importer and the fixture validator. */

import {
  networkManifestSchema,
  type NetworkManifest,
  type SegmentTimes
} from "@paris-transit/contracts";

export type ValidationIssue = {
  path: string;
  message: string;
};

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function parseNetwork(value: unknown): NetworkManifest {
  return networkManifestSchema.parse(value);
}

export function validateNetworkReferences(network: NetworkManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lineIds = new Set(network.lines.map((line) => line.id));
  const stopIds = new Set(network.stops.map((stop) => stop.id));
  const stopById = new Map(network.stops.map((stop) => [stop.id, stop]));

  for (const id of duplicates(network.lines.map((line) => line.id))) {
    issues.push({ path: "lines", message: `Duplicate line id: ${id}` });
  }
  for (const id of duplicates(network.stops.map((stop) => stop.id))) {
    issues.push({ path: "stops", message: `Duplicate stop id: ${id}` });
  }

  for (const [lineIndex, line] of network.lines.entries()) {
    for (const id of duplicates(line.directions.map((direction) => direction.id))) {
      issues.push({
        path: `lines.${String(lineIndex)}.directions`,
        message: `Duplicate direction id on ${line.id}: ${id}`
      });
    }

    for (const [directionIndex, direction] of line.directions.entries()) {
      for (const stopId of direction.stopIds) {
        if (!stopIds.has(stopId)) {
          issues.push({
            path: `lines.${String(lineIndex)}.directions.${String(directionIndex)}.stopIds`,
            message: `Unknown stop id: ${stopId}`
          });
        } else if (!stopById.get(stopId)?.lineIds.includes(line.id)) {
          issues.push({
            path: `lines.${String(lineIndex)}.directions.${String(directionIndex)}.stopIds`,
            message: `Stop ${stopId} does not reference line ${line.id}`
          });
        }
      }
    }
  }

  for (const [stopIndex, stop] of network.stops.entries()) {
    for (const lineId of stop.lineIds) {
      if (!lineIds.has(lineId)) {
        issues.push({
          path: `stops.${String(stopIndex)}.lineIds`,
          message: `Unknown line id: ${lineId}`
        });
      } else if (
        !network.lines
          .find((line) => line.id === lineId)
          ?.directions.some((direction) => direction.stopIds.includes(stop.id))
      ) {
        issues.push({
          path: `stops.${String(stopIndex)}.lineIds`,
          message: `Line ${lineId} does not reference stop ${stop.id}`
        });
      }
    }
  }

  return issues;
}

export function validateSegmentTimes(
  network: NetworkManifest,
  segmentTimes: SegmentTimes
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (segmentTimes.topologyVersion !== network.topologyVersion) {
    issues.push({ path: "segment-times.topologyVersion", message: "Topology version mismatch" });
  }
  for (const line of network.lines) {
    for (const direction of line.directions) {
      const segments = segmentTimes.segments[direction.id];
      if (segments?.length !== direction.stopIds.length - 1) {
        issues.push({
          path: `segment-times.${direction.id}`,
          message: "Incomplete segment timing"
        });
        continue;
      }
      for (const [index, segment] of segments.entries()) {
        if (
          segment.fromStopId !== direction.stopIds[index] ||
          segment.toStopId !== direction.stopIds[index + 1]
        ) {
          issues.push({
            path: `segment-times.${direction.id}.${String(index)}`,
            message: "Segment occurrence does not match direction order"
          });
        }
      }
    }
  }
  return issues;
}
