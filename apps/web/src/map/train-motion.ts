/**
 * Turns train estimates into what the map draws each frame: a position on the display network,
 * smooth catch-up motion that never runs backwards, and fades for appearing and leaving trains.
 */

import type { NetworkManifest, SegmentTimes, Train } from "@paris-transit/contracts";
import {
  buildPatternTimelines,
  indexPatterns,
  mergedCoastingTrainIds,
  placementParameters,
  positionAt,
  timelineSeconds,
  type DisplayTrain,
  type PatternNetwork,
  type PatternTimeline,
  type TimelinePosition
} from "@paris-transit/transit-core/display";
import {
  pointAlongDisplaySegment,
  stationPortKey,
  type DisplayDirection,
  type DisplayLayout
} from "./route-geometry.js";

const maximumCatchUpSpeed = 2;
const correctionSeconds = 10;
const crossFadeAfterSeconds = 180;
const fadeMs = 500;
const hubFadeMs = 200;
const mergeRefreshMs = 250;

export type TrainScene = {
  network: PatternNetwork;
  layout: DisplayLayout;
  /** Stations serving three or more lines, where docked trains are hidden. */
  hubStopIds: ReadonlySet<string>;
};

export type TrainMark = {
  id: string;
  lineId: string;
  longitude: number;
  latitude: number;
  /** Degrees clockwise from north; absent while docked. */
  bearing?: number | undefined;
  alpha: number;
  frozen: boolean;
};

/** `ghosts` are marks fading out where a train was last drawn. */
export type TrainFrame = { trains: TrainMark[]; ghosts: TrainMark[] };

type TrainMotion = {
  patternId: string;
  /** Displayed seconds along the pattern timeline. */
  shown: number;
  started: boolean;
  appearedAt: number;
  atHub: boolean;
  hubChangedAt: number;
  mark?: TrainMark | undefined;
};

export type MotionState = {
  trains: Map<string, TrainMotion>;
  ghosts: { mark: TrainMark; since: number }[];
  merged: Set<string>;
  mergedAt: number;
  lastFrameAt?: number | undefined;
};

export function buildTrainNetwork(
  manifest: NetworkManifest,
  segmentTimes: SegmentTimes
): PatternNetwork {
  return indexPatterns(buildPatternTimelines(manifest, segmentTimes));
}

export function hubStopIds(manifest: NetworkManifest): Set<string> {
  return new Set(manifest.stops.filter((stop) => stop.lineIds.length >= 3).map((stop) => stop.id));
}

export function toDisplayTrains(trains: readonly Train[]): DisplayTrain[] {
  return trains.map((train) => ({
    id: train.id,
    lineId: train.lineId,
    patternId: train.patternId,
    virtualStartAt: Date.parse(train.virtualStartAt),
    holdStopIndex: train.holdStopIndex,
    lastEvidenceAt: Date.parse(train.lastEvidenceAt),
    state: train.state,
    stateSince: Date.parse(train.stateSince)
  }));
}

export function createMotionState(): MotionState {
  return { trains: new Map(), ghosts: [], merged: new Set(), mergedAt: -Infinity };
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function ramp(elapsedMs: number, durationMs: number): number {
  return clamp(elapsedMs / durationMs);
}

/** Falls from 1 to 0 as a train reaches the end of its trip or its coasting timeout. */
function lifetimeAlpha(train: DisplayTrain, position: TimelinePosition, now: number): number {
  if (position.kind === "not_started") return 0;
  let alpha = 1;
  if (position.kind === "terminus") {
    const remainingMs =
      (placementParameters.terminusRemovalSeconds - position.secondsSinceArrival) * 1000;
    alpha = Math.min(alpha, clamp(remainingMs / fadeMs));
  }
  if (train.state === "coasting") {
    const remainingMs =
      placementParameters.coastingTimeoutSeconds * 1000 - (now - train.lastEvidenceAt);
    alpha = Math.min(alpha, clamp(remainingMs / fadeMs));
  }
  return alpha;
}

/** Trains the map shows on each line at `now`, before short fades. */
export function visibleTrainCounts(
  trains: readonly DisplayTrain[],
  network: PatternNetwork,
  now: number
): Map<string, number> {
  const merged = mergedCoastingTrainIds(trains, network, now);
  const counts = new Map<string, number>();
  for (const train of trains) {
    const timeline = network.patterns.get(train.patternId)?.timeline;
    if (!timeline || merged.has(train.id)) continue;
    const position = positionAt(timeline, timelineSeconds(train, timeline, now));
    if (lifetimeAlpha(train, position, now) <= 0) continue;
    counts.set(train.lineId, (counts.get(train.lineId) ?? 0) + 1);
  }
  return counts;
}

function placeOnMap(
  lineId: string,
  timeline: PatternTimeline,
  direction: DisplayDirection,
  position: Exclude<TimelinePosition, { kind: "not_started" }>,
  layout: DisplayLayout
): { longitude: number; latitude: number; bearing?: number; stopId?: string } | undefined {
  if (position.kind === "moving") {
    const index = position.segmentIndex;
    return pointAlongDisplaySegment(
      direction,
      timeline.stopIds[index] ?? "",
      timeline.stopIds[index + 1] ?? "",
      position.progress,
      index
    );
  }
  const stopId = timeline.stopIds[position.stopIndex] ?? "";
  const coordinate =
    layout.stationPorts.get(stationPortKey(lineId, stopId)) ??
    layout.stationCoordinates.get(stopId);
  return coordinate ? { longitude: coordinate[0], latitude: coordinate[1], stopId } : undefined;
}

function retire(state: MotionState, mark: TrainMark | undefined, now: number, reduced: boolean) {
  if (mark && mark.alpha > 0 && !reduced) state.ghosts.push({ mark, since: now });
}

/**
 * Advances every train's displayed position to `now` and returns what to draw. A train's displayed
 * time moves toward its target at 0× to 2× timetable speed, so it never moves backwards; errors
 * over 180 s cross-fade instead. Reduced motion jumps straight to the target without fades.
 */
export function trainFrame(
  trains: readonly DisplayTrain[],
  scene: TrainScene,
  state: MotionState,
  now: number,
  reducedMotion: boolean
): TrainFrame {
  const previousFrameAt = state.lastFrameAt ?? now;
  const elapsedSeconds = Math.max(0, (now - previousFrameAt) / 1000);
  state.lastFrameAt = now;
  if (reducedMotion || now - state.mergedAt >= mergeRefreshMs) {
    state.merged = mergedCoastingTrainIds(trains, scene.network, now);
    state.mergedAt = now;
  }

  const marks: TrainMark[] = [];
  const current = new Set<string>();
  for (const train of trains) {
    const timeline = scene.network.patterns.get(train.patternId)?.timeline;
    const direction = scene.layout.directions.get(train.patternId);
    if (!timeline || !direction || state.merged.has(train.id)) continue;
    current.add(train.id);
    const target = timelineSeconds(train, timeline, now);

    let motion = state.trains.get(train.id);
    if (motion && motion.patternId !== train.patternId) {
      retire(state, motion.mark, now, reducedMotion);
      motion = undefined;
    }
    if (!motion) {
      motion = {
        patternId: train.patternId,
        shown: target,
        started: target >= 0,
        appearedAt: now,
        atHub: false,
        hubChangedAt: -Infinity
      };
      state.trains.set(train.id, motion);
    } else if (reducedMotion) {
      motion.shown = target;
    } else if (Math.abs(target - motion.shown) > crossFadeAfterSeconds) {
      retire(state, motion.mark, now, reducedMotion);
      motion.mark = undefined;
      motion.shown = target;
      motion.appearedAt = now;
    } else {
      // Speed and error are measured at the previous frame, so a corrected estimate changes the
      // error but not the timetable speed.
      const before = timelineSeconds(train, timeline, previousFrameAt);
      const targetSpeed = elapsedSeconds > 0 ? clamp((target - before) / elapsedSeconds) : 0;
      const error = before - motion.shown;
      const speed = clamp(targetSpeed + error / correctionSeconds, 0, maximumCatchUpSpeed);
      const advanced = motion.shown + speed * elapsedSeconds;
      motion.shown = target > motion.shown ? Math.min(advanced, target) : advanced;
    }

    const position = positionAt(timeline, motion.shown);
    if (position.kind === "not_started") {
      motion.mark = undefined;
      continue;
    }
    if (!motion.started) {
      motion.started = true;
      motion.appearedAt = now;
    }
    const place = placeOnMap(train.lineId, timeline, direction, position, scene.layout);
    if (!place) {
      motion.mark = undefined;
      continue;
    }

    const atHub = place.stopId !== undefined && scene.hubStopIds.has(place.stopId);
    if (atHub !== motion.atHub) {
      motion.atHub = atHub;
      if (motion.mark) motion.hubChangedAt = now;
    }
    const hubProgress = ramp(now - motion.hubChangedAt, hubFadeMs);
    const rawAlpha =
      (reducedMotion ? 1 : ramp(now - motion.appearedAt, fadeMs)) *
      (atHub ? 1 - hubProgress : hubProgress) *
      lifetimeAlpha(train, position, now);
    const mark: TrainMark = {
      id: train.id,
      lineId: train.lineId,
      longitude: place.longitude,
      latitude: place.latitude,
      bearing: place.bearing,
      alpha: reducedMotion ? (rawAlpha > 0 ? 1 : 0) : rawAlpha,
      frozen: train.state === "frozen"
    };
    motion.mark = mark;
    marks.push(mark);
  }

  for (const [id, motion] of state.trains) {
    if (current.has(id)) continue;
    retire(state, motion.mark, now, reducedMotion);
    state.trains.delete(id);
  }
  state.ghosts = reducedMotion ? [] : state.ghosts.filter((ghost) => now - ghost.since < fadeMs);
  return {
    trains: marks,
    ghosts: state.ghosts.map((ghost) => ({
      ...ghost.mark,
      alpha: ghost.mark.alpha * (1 - ramp(now - ghost.since, fadeMs))
    }))
  };
}
