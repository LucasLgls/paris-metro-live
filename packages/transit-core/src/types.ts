/** Provider-neutral realtime input: platform countdowns, not train positions. */

/** Provider hint that the train is already at, or about to reach, the platform. */
export type PredictionNote = "at_platform" | "approaching";

/** One platform countdown: a train of `lineId` bound for `destinationStopId` is expected at
 * `stopId` at `expectedAt` (epoch milliseconds). */
export type Prediction = {
  lineId: string;
  stopId: string;
  destinationStopId: string;
  expectedAt: number;
  note?: PredictionNote;
};

/** One provider refresh. Times are epoch milliseconds; nothing here is train-shaped. */
export type RealtimeFeed = {
  source: "fixture" | "prim";
  feedAt: number;
  receivedAt: number;
  predictions: Prediction[];
  quotaRemaining?: number;
  /** Time until the provider quota resets, when the provider reports it. */
  quotaResetAfterMs?: number;
  retryAfterMs?: number;
};

/** A realtime provider. The fixture simulator and the PRIM client implement it. */
export type RealtimeSource = {
  readonly kind: "fixture" | "prim";
  poll(signal?: AbortSignal): Promise<RealtimeFeed>;
};

export type Clock = () => Date;
