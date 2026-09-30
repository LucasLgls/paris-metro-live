import type { ServiceStatus, TrainSnapshot } from "@paris-transit/contracts";
import { describe, expect, it, vi } from "vitest";

import { InMemoryLiveStore } from "./store.js";

const snapshot: Omit<TrainSnapshot, "sequence"> = {
  schemaVersion: 2,
  topologyVersion: "topology/v1",
  feedAt: "2026-09-28T07:30:00.000Z",
  generatedAt: "2026-09-28T07:30:20.000Z",
  lines: [{ lineId: "metro-1", state: "live" }],
  trains: []
};

const status: ServiceStatus = {
  schemaVersion: 1,
  status: "healthy",
  source: "fixture",
  generatedAt: "2026-09-28T07:30:20.000Z",
  sourceObservedAt: "2026-09-28T07:30:00.000Z",
  sourceAgeSeconds: 20,
  pollIntervalSeconds: 120,
  supportedLines: 1,
  message: "fresh"
};

describe("InMemoryLiveStore", () => {
  it("stores sequenced snapshots and notifies subscribers once per snapshot", async () => {
    const store = new InMemoryLiveStore();
    const listener = vi.fn();
    const unsubscribe = await store.subscribe(listener);

    await store.setSnapshot(snapshot);
    await store.setStatus(status);

    expect(await store.getSnapshot()).toEqual({ ...snapshot, sequence: 1 });
    expect(await store.getStatus()).toEqual(status);
    expect(listener).toHaveBeenCalledOnce();

    await unsubscribe();
    await store.setSnapshot(snapshot);
    expect((await store.getSnapshot())?.sequence).toBe(2);
    expect(listener).toHaveBeenCalledOnce();
  });
});
