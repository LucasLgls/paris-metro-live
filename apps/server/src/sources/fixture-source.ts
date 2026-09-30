import type {
  Clock,
  PatternTimeline,
  RealtimeFeed,
  RealtimeSource
} from "@paris-transit/transit-core";

import { providerRefreshMs } from "../ingestor.js";
import { TrainSimulator } from "./simulator.js";

/** Seeded simulated countdowns, published on the same 120 s refresh boundaries as PRIM. */
export class FixtureRealtimeSource implements RealtimeSource {
  readonly kind = "fixture" as const;
  private readonly simulator: TrainSimulator;

  constructor(
    timelines: readonly PatternTimeline[],
    lineIds: readonly string[],
    private readonly clock: Clock = () => new Date()
  ) {
    this.simulator = new TrainSimulator(timelines, lineIds, { seed: 1 });
  }

  poll(): Promise<RealtimeFeed> {
    const receivedAt = this.clock().getTime();
    const feedAt = Math.floor(receivedAt / providerRefreshMs) * providerRefreshMs;
    return Promise.resolve({
      source: "fixture",
      feedAt,
      receivedAt,
      predictions: this.simulator.predictionsAt(feedAt)
    });
  }
}
