/**
 * The placement rules shared by the server and the browser, exported as
 * `@paris-transit/transit-core/display` so the browser does not bundle the tracker.
 */

import { pointsConflict, trackPoints, type PatternNetwork, type TrackPoint } from "./estimator.js";
import { timelineSeconds, type TimelineTrain } from "./timeline.js";

export { indexPatterns, placementParameters, type PatternNetwork } from "./estimator.js";
export * from "./timeline.js";

/** The train fields the server and browser share for placement; times are epoch milliseconds. */
export type DisplayTrain = TimelineTrain & {
  id: string;
  lineId: string;
  patternId: string;
  lastEvidenceAt: number;
};

type Placed = { train: DisplayTrain; x: number; points: TrackPoint[] };

function place(train: DisplayTrain, network: PatternNetwork, at: number): Placed | undefined {
  const timeline = network.patterns.get(train.patternId)?.timeline;
  if (!timeline) return undefined;
  const x = timelineSeconds(train, timeline, at);
  return { train, x, points: trackPoints(train.patternId, x, network) };
}

/** `other` is ahead of `coasting` on its pattern now, but was behind it when it began to coast. */
function overtook(other: Placed, coasting: Placed, network: PatternNetwork): boolean {
  const pattern = coasting.train.patternId;
  if (!other.points.some((point) => point.patternId === pattern && point.x >= coasting.x)) {
    return false;
  }
  const since = coasting.train.stateSince;
  const then = place(other.train, network, since);
  const coastingThen = place(coasting.train, network, since);
  return Boolean(
    then &&
      coastingThen &&
      then.points.some((point) => point.patternId === pattern && point.x < coastingThen.x)
  );
}

/**
 * Coasting trains merged into another train at `now`: one within G of it on the same track, or one
 * that has overtaken it while it waited. Between two coasting trains, fresher evidence wins.
 */
export function mergedCoastingTrainIds(
  trains: readonly DisplayTrain[],
  network: PatternNetwork,
  now: number
): Set<string> {
  const merged = new Set<string>();
  const lines = new Set(
    trains.filter((train) => train.state === "coasting").map((train) => train.lineId)
  );
  for (const lineId of lines) {
    const onLine = trains.filter((train) => train.lineId === lineId);
    const kept = onLine
      .filter((train) => train.state !== "coasting")
      .map((train) => place(train, network, now))
      .filter((placed): placed is Placed => placed !== undefined && placed.points.length > 0);
    const coasting = onLine
      .filter((train) => train.state === "coasting")
      .sort(
        (left, right) =>
          right.lastEvidenceAt - left.lastEvidenceAt ||
          left.virtualStartAt - right.virtualStartAt ||
          left.id.localeCompare(right.id)
      );
    for (const train of coasting) {
      const placed = place(train, network, now);
      if (!placed || placed.points.length === 0) continue;
      if (
        kept.some(
          (other) => pointsConflict(placed.points, other.points) || overtook(other, placed, network)
        )
      ) {
        merged.add(train.id);
      } else {
        kept.push(placed);
      }
    }
  }
  return merged;
}
