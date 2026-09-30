import { schemaVersion, segmentTimesSchema, type SegmentTimes } from "@paris-transit/contracts";

/** A single stop event on a GTFS trip, with times already parsed to seconds. */
export type GtfsStopTime = {
  stopSequence: number;
  stopId: string;
  arrival: number;
  departure: number;
};

export type DirectionSpec = { id: string; stopIds: readonly string[] };

/** Parse a GTFS `HH:MM:SS` time to seconds since noon-12h. Hours may exceed 24 (after midnight). */
export function parseGtfsTime(value: string): number {
  const [hours, minutes, seconds] = value.split(":").map((part) => Number.parseInt(part, 10));
  if (hours === undefined || minutes === undefined || seconds === undefined) {
    throw new Error(`Invalid GTFS time: ${value}`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return Math.round(value);
}

/**
 * Aggregate per-segment run and dwell times for a line from its GTFS trips. Each trip's mapped
 * internal stops are matched to the direction whose stop order they follow one step at a time; every
 * consecutive pair contributes a run time (next arrival − this departure) and the from-stop's dwell
 * (its departure − arrival). The median across all observed trips is taken per segment. A segment
 * that no trip covers is a hard error — the caller should not silently ship a gap.
 */
export function computeSegmentTimes(params: {
  topologyVersion: string;
  directions: readonly DirectionSpec[];
  stopIdByGtfsId: Readonly<Record<string, string>>;
  stopTimesByTrip: Readonly<Record<string, readonly GtfsStopTime[]>>;
}): SegmentTimes {
  const { topologyVersion, directions, stopIdByGtfsId, stopTimesByTrip } = params;
  type Observation = { runs: number[]; dwells: number[] };
  const observed = new Map<string, Map<number, Observation>>();

  for (const rows of Object.values(stopTimesByTrip)) {
    const ordered = [...rows]
      .sort((left, right) => left.stopSequence - right.stopSequence)
      .map((row) => ({ ...row, internalStopId: stopIdByGtfsId[row.stopId] }))
      .filter((row): row is typeof row & { internalStopId: string } => row.internalStopId != null);
    if (ordered.length < 2) continue;

    const match = directions
      .map((direction) => ({
        direction,
        startIndex: findContiguousSequence(
          direction.stopIds,
          ordered.map((row) => row.internalStopId)
        )
      }))
      .find((candidate) => candidate.startIndex >= 0);
    if (!match) continue;

    const bySegment = observed.get(match.direction.id) ?? new Map<number, Observation>();
    observed.set(match.direction.id, bySegment);
    for (let i = 0; i < ordered.length - 1; i++) {
      const from = ordered[i];
      const to = ordered[i + 1];
      if (!from || !to) continue;
      const segmentIndex = match.startIndex + i;
      const entry = bySegment.get(segmentIndex) ?? { runs: [], dwells: [] };
      entry.runs.push(to.arrival - from.departure);
      entry.dwells.push(from.departure - from.arrival);
      bySegment.set(segmentIndex, entry);
    }
  }

  const segments: Record<string, SegmentTimes["segments"][string]> = {};
  for (const direction of directions) {
    const bySegment = observed.get(direction.id);
    const entries: SegmentTimes["segments"][string] = [];
    for (let i = 0; i < direction.stopIds.length - 1; i++) {
      const fromStopId = direction.stopIds[i];
      const toStopId = direction.stopIds[i + 1];
      if (fromStopId === undefined || toStopId === undefined) continue;
      const observation = bySegment?.get(i);
      if (!observation || observation.runs.length === 0) {
        throw new Error(
          `No GTFS trips observed for segment ${fromStopId} → ${toStopId} on ${direction.id}`
        );
      }
      entries.push({
        fromStopId,
        toStopId,
        runSeconds: median(observation.runs),
        dwellSeconds: median(observation.dwells)
      });
    }
    segments[direction.id] = entries;
  }

  return segmentTimesSchema.parse({ schemaVersion, topologyVersion, segments });
}

function findContiguousSequence(
  directionStops: readonly string[],
  observedStops: readonly string[]
): number {
  if (observedStops.length > directionStops.length) return -1;
  const lastStart = directionStops.length - observedStops.length;
  for (let start = 0; start <= lastStart; start++) {
    if (observedStops.every((stopId, offset) => directionStops[start + offset] === stopId)) {
      return start;
    }
  }
  return -1;
}
