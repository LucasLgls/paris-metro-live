import type { NetworkManifest } from "@paris-transit/contracts";
import type { PatternTimeline, RealtimeFeed, RealtimeSource } from "@paris-transit/transit-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IngestionLoop, nextRefreshPollDelay } from "./ingestor.js";
import { PrimHttpError } from "./sources/prim-source.js";
import { InMemoryLiveStore } from "./store.js";

const geometry = {
  type: "LineString" as const,
  coordinates: [
    [2.3, 48.8],
    [2.4, 48.9]
  ] as [number, number][]
};

const manifest: NetworkManifest = {
  schemaVersion: 1,
  topologyVersion: "test/v1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: "test",
  attribution: "test",
  lines: [
    {
      id: "line",
      code: "1",
      name: "Test line",
      mode: "metro",
      color: "#000000",
      textColor: "#FFFFFF",
      operator: "test",
      capability: "estimated_segment",
      directions: [
        { id: "east", name: "Gamma", stopIds: ["a", "b", "c"], geometry },
        { id: "west", name: "Alpha", stopIds: ["c", "b", "a"], geometry }
      ]
    }
  ],
  stops: [
    { id: "a", name: "Alpha", longitude: 2.3, latitude: 48.8, lineIds: ["line"] },
    { id: "b", name: "Beta", longitude: 2.35, latitude: 48.85, lineIds: ["line"] },
    { id: "c", name: "Gamma", longitude: 2.4, latitude: 48.9, lineIds: ["line"] }
  ]
};

const timelines: PatternTimeline[] = [
  {
    id: "east",
    lineId: "line",
    name: "Gamma",
    stopIds: ["a", "b", "c"],
    arr: [0, 60, 140],
    dep: [0, 80, 140]
  },
  {
    id: "west",
    lineId: "line",
    name: "Alpha",
    stopIds: ["c", "b", "a"],
    arr: [0, 60, 140],
    dep: [0, 80, 140]
  }
];

/** A provider that refreshes every 120 s, reporting one train on "east". */
function feedAt(feedTime: number, extra: Partial<RealtimeFeed> = {}): RealtimeFeed {
  return {
    source: "prim",
    feedAt: feedTime,
    receivedAt: Date.now(),
    predictions: [
      { lineId: "line", stopId: "b", destinationStopId: "c", expectedAt: feedTime + 30_000 },
      { lineId: "line", stopId: "c", destinationStopId: "c", expectedAt: feedTime + 110_000 }
    ],
    ...extra
  };
}

const currentRefresh = () => Math.floor(Date.now() / 120_000) * 120_000;

function fakeSource(
  poll: RealtimeSource["poll"],
  kind: RealtimeSource["kind"] = "prim"
): RealtimeSource {
  return { kind, poll };
}

function loop(
  source: RealtimeSource,
  store = new InMemoryLiveStore(),
  logger?: { info: () => void; warn: () => void }
) {
  return new IngestionLoop(source, store, manifest, timelines, logger ? { logger } : {});
}

afterEach(() => {
  vi.useRealTimers();
});

describe("phase-locked ingestion", () => {
  it("polls 45 s after each 120 s provider refresh", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-09-14T10:00:00.000Z");
    vi.setSystemTime(epoch);
    const attempts: number[] = [];
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        attempts.push(Date.now() - epoch.getTime());
        return Promise.resolve(feedAt(currentRefresh()));
      }),
      store
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(420_000);
    ingestion.stop();

    expect(attempts).toEqual([0, 165_000, 285_000, 405_000]);
    expect((await store.getSnapshot())?.sequence).toBe(4);
    expect(await store.getStatus()).toMatchObject({ status: "healthy", pollIntervalSeconds: 120 });
  });

  it("stays within about 720 requests a day without the night pause", () => {
    let polls = 0;
    let now = 0;
    let feed = 0;
    while (now < 24 * 60 * 60 * 1000) {
      polls += 1;
      feed = Math.floor(now / 120_000) * 120_000;
      now += nextRefreshPollDelay(feed, now);
    }
    expect(polls).toBeLessThanOrEqual(721);
  });

  it("retries once after 30 s when the timestamp has not moved, without failing", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-09-14T10:00:00.000Z");
    vi.setSystemTime(epoch);
    const attempts: number[] = [];
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        const elapsed = Date.now() - epoch.getTime();
        attempts.push(elapsed);
        return Promise.resolve(feedAt(elapsed < 200_000 ? epoch.getTime() : currentRefresh()));
      }),
      store
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(attempts).toEqual([0, 165_000, 195_000]);
    expect((await store.getSnapshot())?.sequence).toBe(1);
    expect((await store.getStatus())?.status).toBe("healthy");

    await vi.advanceTimersByTimeAsync(210_000);
    ingestion.stop();
    expect(attempts).toEqual([0, 165_000, 195_000, 285_000, 405_000]);
    expect((await store.getSnapshot())?.sequence).toBe(3);
  });

  it("freezes every line once the feed is more than five minutes old", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-09-14T10:00:00.000Z");
    vi.setSystemTime(epoch);
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => Promise.resolve(feedAt(epoch.getTime()))),
      store
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await store.getSnapshot())?.lines).toEqual([{ lineId: "line", state: "live" }]);

    await vi.advanceTimersByTimeAsync(15_000);
    ingestion.stop();
    const snapshot = await store.getSnapshot();
    expect(snapshot?.lines).toEqual([
      { lineId: "line", state: "frozen", since: "2026-09-14T10:05:15.000Z" }
    ]);
    expect(snapshot?.trains.every((train) => train.state === "frozen")).toBe(true);
    expect(await store.getStatus()).toMatchObject({
      status: "degraded",
      message: "Realtime source is stale; live data paused"
    });
  });

  it("never polls sooner than 30 s, even just before the feed turns stale", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-09-14T10:00:00.000Z");
    vi.setSystemTime(epoch);
    const attempts: number[] = [];
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        attempts.push(Date.now() - epoch.getTime());
        return Promise.resolve(feedAt(epoch.getTime() - 230_000));
      }),
      store
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(90_000);
    ingestion.stop();

    expect(attempts).toEqual([0, 55_000, 85_000]);
    expect(await store.getStatus()).toMatchObject({
      status: "degraded",
      message: "Realtime source is stale; live data paused"
    });
  });

  it("freezes on failure, backs off to ten minutes, and resumes live after recovery", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-09-14T10:00:00.000Z");
    vi.setSystemTime(epoch);
    const attempts: number[] = [];
    let calls = 0;
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        attempts.push(Date.now() - epoch.getTime());
        return calls >= 2 && calls <= 5
          ? Promise.reject(new Error("provider failure"))
          : Promise.resolve(feedAt(currentRefresh()));
      }),
      store
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(165_000);
    expect((await store.getSnapshot())?.lines[0]?.state).toBe("frozen");
    expect((await store.getStatus())?.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(1_240_000);
    ingestion.stop();

    expect(attempts).toEqual([0, 165_000, 255_000, 435_000, 795_000, 1_395_000]);
    expect((await store.getSnapshot())?.lines[0]?.state).toBe("live");
    expect(await store.getStatus()).toMatchObject({
      status: "healthy",
      message: "Realtime source recovered"
    });
  });

  it("pauses PRIM overnight and reports no Métro service", async () => {
    vi.useFakeTimers();
    // 02:40 in Paris (CEST).
    vi.setSystemTime(new Date("2026-09-14T00:40:00.000Z"));
    let calls = 0;
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        return Promise.resolve(feedAt(currentRefresh()));
      }),
      store
    );

    await ingestion.start();
    expect(calls).toBe(0);
    expect(await store.getStatus()).toMatchObject({
      status: "no_service",
      message: "No Métro service at this hour"
    });
    await vi.advanceTimersByTimeAsync(140 * 60_000 - 1);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    ingestion.stop();
    expect(calls).toBe(1);
  });

  it("does not pause the fixture simulator overnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:40:00.000Z"));
    let calls = 0;
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        return Promise.resolve(feedAt(currentRefresh(), { source: "fixture" }));
      }, "fixture")
    );

    await ingestion.start();
    ingestion.stop();
    expect(calls).toBe(1);
  });

  it("pauses at the quota reserve for a day, or longer when PRIM asks", async () => {
    vi.useFakeTimers();
    const epoch = new Date("2026-10-24T22:30:00.000Z");
    vi.setSystemTime(epoch);
    let calls = 0;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = new InMemoryLiveStore();
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        return Promise.resolve(
          feedAt(currentRefresh(), {
            quotaRemaining: calls === 1 ? 10 : 1000,
            ...(calls === 1 ? { retryAfterMs: 26 * 60 * 60 * 1000 } : {})
          })
        );
      }),
      store,
      logger
    );

    await ingestion.start();
    expect((await store.getStatus())?.status).toBe("degraded");
    await vi.advanceTimersByTimeAsync(26 * 60 * 60 * 1000 - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    ingestion.stop();

    expect(calls).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "prim_quota_paused", quotaRemaining: 10 }),
      expect.any(String)
    );
  });

  it("resumes one minute after the quota reset the provider reports", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    const resetAfterMs = 4 * 60 * 60 * 1000 + 22 * 60 * 1000;
    let calls = 0;
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        return Promise.resolve(
          feedAt(currentRefresh(), {
            quotaRemaining: calls === 1 ? 10 : 999,
            ...(calls === 1 ? { quotaResetAfterMs: resetAfterMs } : {})
          })
        );
      })
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(resetAfterMs + 60_000 - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    ingestion.stop();

    expect(calls).toBe(2);
  });

  it("honours a provider Retry-After longer than the first failure delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    let calls = 0;
    const ingestion = loop(
      fakeSource(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new PrimHttpError(503, 240_000, 100))
          : Promise.resolve(feedAt(currentRefresh()));
      })
    );

    await ingestion.start();
    await vi.advanceTimersByTimeAsync(239_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    ingestion.stop();
    expect(calls).toBe(2);
  });

  it("rejects a feed from another source or from the future as a failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    const mismatch = new InMemoryLiveStore();
    const future = new InMemoryLiveStore();

    const first = loop(
      fakeSource(() => Promise.resolve(feedAt(currentRefresh(), { source: "fixture" }))),
      mismatch
    );
    const second = loop(
      fakeSource(() => Promise.resolve(feedAt(Date.now() + 120_000))),
      future
    );
    await first.start();
    await second.start();
    first.stop();
    second.stop();

    expect((await mismatch.getStatus())?.status).toBe("unavailable");
    expect((await future.getStatus())?.status).toBe("unavailable");
  });

  it("aborts an in-flight poll without publishing a failure status", async () => {
    const store = new InMemoryLiveStore();
    const source: RealtimeSource = {
      kind: "prim",
      poll: (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    const ingestion = loop(source, store);

    const starting = ingestion.start();
    await Promise.resolve();
    ingestion.stop();
    await starting;

    expect(await store.getStatus()).toBeUndefined();
  });
});
