import type { PatternTimeline, Prediction } from "@paris-transit/transit-core";

export type SimulatorOptions = {
  seed: number;
  /** One scripted outage: the line emits no prediction while `from <= feedAt < to`. */
  outage?: { lineId: string; from: number; to: number };
};

/** A ground-truth train, placed on its pattern's nominal timeline. */
export type TruthTrain = { id: string; lineId: string; patternId: string; x: number };

type Trip = {
  id: string;
  pattern: PatternTimeline;
  arrivals: number[];
  departures: number[];
};

const predictionsPerPlatform = 4;
const dropoutRate = 0.05;
const runNoise = 0.05;
const dwellNoiseSeconds = 5;
const dispatchJitter = 0.15;
const approachSeconds = 30;
const horizonSeconds = 600;

function mix(seed: number, parts: readonly (string | number)[]): number {
  let result = 2_166_136_261 ^ seed;
  for (const character of parts.join("|")) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function edges(timeline: PatternTimeline): string[] {
  return timeline.stopIds
    .slice(1)
    .map((stopId, index) => `${timeline.stopIds[index] ?? ""}|${stopId}`);
}

/** Groups a line's patterns that share at least one directed edge. */
function sharedTrackGroups(timelines: readonly PatternTimeline[]): PatternTimeline[][] {
  const groups: PatternTimeline[][] = [];
  for (const timeline of [...timelines].sort((left, right) => left.id.localeCompare(right.id))) {
    const own = new Set(edges(timeline));
    const touching = groups.filter((group) =>
      group.some((other) => edges(other).some((edge) => own.has(edge)))
    );
    const merged = [...touching.flat(), timeline];
    for (const group of touching) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups;
}

/** Milliseconds to add to `timeline`'s phase so it reaches its first edge shared with `reference`
 * at the same moment as `reference`. */
function firstSharedOffset(reference: PatternTimeline, timeline: PatternTimeline): number {
  const own = edges(timeline);
  const referenceIndex = edges(reference).findIndex((edge) => own.includes(edge));
  const edge = edges(reference)[referenceIndex];
  if (referenceIndex < 0 || edge === undefined) return 0;
  const timelineIndex = own.indexOf(edge);
  return ((reference.dep[referenceIndex] ?? 0) - (timeline.dep[timelineIndex] ?? 0)) * 1000;
}

/**
 * A seeded, stateless train simulator: every trip, its stop times, and every prediction are pure
 * functions of the seed and the timestamp, so any instant can be reproduced.
 */
export class TrainSimulator {
  private readonly patterns: readonly {
    timeline: PatternTimeline;
    headway: number;
    phase: number;
    jitter: number;
  }[];

  constructor(
    timelines: readonly PatternTimeline[],
    lineIds: readonly string[],
    private readonly options: SimulatorOptions = { seed: 1 }
  ) {
    const patterns: TrainSimulator["patterns"][number][] = [];
    for (const lineId of lineIds) {
      const lineHeadway = (150 + this.unit("headway", lineId) * 150) * 1000;
      for (const group of sharedTrackGroups(timelines.filter((item) => item.lineId === lineId))) {
        const [reference] = group;
        if (!reference) continue;
        const base = this.unit("phase", reference.id) * lineHeadway * group.length;
        // Patterns sharing track run alternately, one line headway apart where they first meet.
        group.forEach((timeline, index) => {
          patterns.push({
            timeline,
            headway: lineHeadway * group.length,
            phase: base + firstSharedOffset(reference, timeline) + index * lineHeadway,
            jitter: dispatchJitter * lineHeadway
          });
        });
      }
    }
    this.patterns = patterns;
  }

  /**
   * The countdowns a provider would publish at `feedAt`: the next few trains at each platform, with
   * noise that grows with the horizon and a few random dropouts.
   */
  predictionsAt(feedAt: number): Prediction[] {
    const outage = this.options.outage;
    const platforms = new Map<string, { trip: Trip; stop: number }[]>();
    for (const trip of this.trips(feedAt, feedAt + horizonSeconds * 1000)) {
      if (
        outage &&
        trip.pattern.lineId === outage.lineId &&
        feedAt >= outage.from &&
        feedAt < outage.to
      ) {
        continue;
      }
      const stopIds = trip.pattern.stopIds;
      for (let stop = 1; stop < stopIds.length; stop += 1) {
        const departure = trip.departures[stop] ?? 0;
        if (departure <= feedAt) continue;
        const key = [
          trip.pattern.lineId,
          stopIds[stop],
          stopIds[stop + 1] ?? `end:${stopIds[stop - 1] ?? ""}`
        ].join("|");
        platforms.set(key, [...(platforms.get(key) ?? []), { trip, stop }]);
      }
    }

    const predictions: Prediction[] = [];
    const platformKeys = [...platforms.keys()].sort((left, right) => left.localeCompare(right));
    for (const calls of platformKeys.map((key) => platforms.get(key) ?? [])) {
      const upcoming = calls
        .sort(
          (left, right) =>
            (left.trip.arrivals[left.stop] ?? 0) - (right.trip.arrivals[right.stop] ?? 0)
        )
        .slice(0, predictionsPerPlatform);
      for (const { trip, stop } of upcoming) {
        const salt = [trip.id, stop, feedAt];
        if (this.unit("dropout", ...salt) < dropoutRate) continue;
        const arrival = trip.arrivals[stop] ?? 0;
        const departure = trip.departures[stop] ?? arrival;
        const docked = arrival <= feedAt;
        const horizon = Math.max(0, (arrival - feedAt) / 1000);
        const sigma = 3 + 0.05 * horizon;
        const expectedAt = Math.round(
          (docked ? departure : arrival) + this.normal(...salt) * sigma * 1000
        );
        const stopId = trip.pattern.stopIds[stop] ?? "";
        predictions.push({
          lineId: trip.pattern.lineId,
          stopId,
          destinationStopId: trip.pattern.stopIds.at(-1) ?? "",
          expectedAt,
          ...(docked
            ? { note: "at_platform" as const }
            : horizon <= approachSeconds
              ? { note: "approaching" as const }
              : {})
        });
      }
    }
    return predictions;
  }

  /** Where every train really is, so tests can measure placement accuracy. */
  truthAt(now: number): TruthTrain[] {
    const trains: TruthTrain[] = [];
    for (const trip of this.trips(now, now)) {
      const x = this.nominalSeconds(trip, now);
      const last = trip.pattern.stopIds.length - 1;
      if (x === undefined || x >= (trip.pattern.arr[last] ?? 0)) continue;
      trains.push({ id: trip.id, lineId: trip.pattern.lineId, patternId: trip.pattern.id, x });
    }
    return trains;
  }

  /** Trips that are running at some point between `from` and `to`, or will start before `to`. */
  private trips(from: number, to: number): Trip[] {
    const trips: Trip[] = [];
    for (const { timeline, headway, phase, jitter } of this.patterns) {
      const duration = (timeline.arr.at(-1) ?? 0) * 1000 * (1 + runNoise) + 60_000;
      const first = Math.floor((from - duration - phase) / headway) - 1;
      const last = Math.ceil((to - phase) / headway) + 1;
      for (let index = first; index <= last; index += 1) {
        const trip = this.trip(timeline, headway, phase, jitter, index);
        if ((trip.departures[0] ?? 0) > to || (trip.arrivals.at(-1) ?? 0) < from) continue;
        trips.push(trip);
      }
    }
    return trips;
  }

  private trip(
    timeline: PatternTimeline,
    headway: number,
    phase: number,
    jitter: number,
    index: number
  ): Trip {
    const id = `${timeline.id}#${String(index)}`;
    let time = index * headway + phase + (this.unit("dispatch", id) - 0.5) * 2 * jitter;
    const arrivals = [time];
    const departures = [time];
    for (let stop = 1; stop < timeline.stopIds.length; stop += 1) {
      const run = (timeline.arr[stop] ?? 0) - (timeline.dep[stop - 1] ?? 0);
      time += run * 1000 * (1 + (this.unit("run", id, stop) - 0.5) * 2 * runNoise);
      arrivals.push(time);
      const dwell = (timeline.dep[stop] ?? 0) - (timeline.arr[stop] ?? 0);
      const noisy =
        dwell === 0
          ? 0
          : Math.max(0, dwell + (this.unit("dwell", id, stop) - 0.5) * 2 * dwellNoiseSeconds);
      time += noisy * 1000;
      departures.push(time);
    }
    return { id, pattern: timeline, arrivals, departures };
  }

  /** The true position expressed on the nominal timeline, or undefined before departure. */
  private nominalSeconds(trip: Trip, now: number): number | undefined {
    const timeline = trip.pattern;
    if (now < (trip.departures[0] ?? 0)) return undefined;
    for (let stop = 0; stop < timeline.stopIds.length; stop += 1) {
      const arrival = trip.arrivals[stop] ?? 0;
      const departure = trip.departures[stop] ?? arrival;
      const nextArrival = trip.arrivals[stop + 1];
      if (now >= arrival && now < departure) {
        const nominalDwell = (timeline.dep[stop] ?? 0) - (timeline.arr[stop] ?? 0);
        return (timeline.arr[stop] ?? 0) + ((now - arrival) / (departure - arrival)) * nominalDwell;
      }
      if (nextArrival !== undefined && now >= departure && now < nextArrival) {
        const nominalRun = (timeline.arr[stop + 1] ?? 0) - (timeline.dep[stop] ?? 0);
        return (
          (timeline.dep[stop] ?? 0) + ((now - departure) / (nextArrival - departure)) * nominalRun
        );
      }
    }
    return (timeline.arr.at(-1) ?? 0) + (now - (trip.arrivals.at(-1) ?? now)) / 1000;
  }

  private unit(...parts: (string | number)[]): number {
    return mix(this.options.seed, parts) / 4_294_967_296;
  }

  private normal(...parts: (string | number)[]): number {
    const first = Math.max(Number.EPSILON, this.unit("normal-a", ...parts));
    const second = this.unit("normal-b", ...parts);
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }
}
