import type { NetworkManifest } from "@paris-transit/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildTerminusIndex,
  PrimHttpError,
  PrimPayloadError,
  PrimPollThrottledError,
  PrimRealtimeSource,
  PrimRequestTimeoutError,
  PrimResponseTooLargeError,
  type PrimRealtimeSourceOptions
} from "./prim-source.js";

type TestCall = {
  stop: string;
  arrival?: string;
  departure?: string;
  aimed?: string;
  note?: string;
  display?: string;
};

function payload(
  responseTimestamp: string,
  calls: TestCall[],
  journeyOverrides: Record<string, unknown> = {}
) {
  return {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: responseTimestamp,
        EstimatedTimetableDelivery: [
          {
            EstimatedJourneyVersionFrame: [
              {
                EstimatedVehicleJourney: [
                  {
                    LineRef: { value: "line" },
                    DirectionRef: { value: "east" },
                    DatedVehicleJourneyRef: "provider-counter-reference",
                    DestinationRef: { value: "provider-terminus" },
                    DestinationName: [{ value: "Beta" }],
                    VehicleMode: "metro",
                    EstimatedCalls: {
                      EstimatedCall: calls.map((call) => ({
                        StopPointRef: { value: call.stop },
                        StopPointName: [{ value: call.stop.toUpperCase() }],
                        ...(call.arrival ? { ExpectedArrivalTime: call.arrival } : {}),
                        ...(call.departure ? { ExpectedDepartureTime: call.departure } : {}),
                        ...(call.aimed ? { AimedArrivalTime: call.aimed } : {}),
                        ...(call.note ? { CallNote: [{ value: call.note }] } : {}),
                        ...(call.display ? { DestinationDisplay: [{ value: call.display }] } : {})
                      }))
                    },
                    ...journeyOverrides
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  };
}

function respond(body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers }
      })
    )
  ) as unknown as typeof fetch;
}

function source(fetchImpl: typeof fetch, options: Partial<PrimRealtimeSourceOptions> = {}) {
  return new PrimRealtimeSource({
    apiKey: "test-only",
    baseUrl: "https://example.test/marketplace",
    fetchImpl,
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    lineIdMap: {},
    stopIdMap: {},
    terminusIndex: {},
    ...options
  });
}

const mapped = {
  lineIdMap: { line: "metro-1" },
  stopIdMap: { a: "station-a", b: "station-b", "provider-terminus": "station-z" }
};

const manifest: NetworkManifest = {
  schemaVersion: 1,
  topologyVersion: "test-v1",
  generatedAt: "2026-08-31T00:00:00.000Z",
  source: "test",
  attribution: "test",
  stops: [
    { id: "station-a", name: "Alpha", longitude: 2.3, latitude: 48.8, lineIds: ["metro-1"] },
    { id: "station-z", name: "Zéta Terminus", longitude: 2.4, latitude: 48.9, lineIds: ["metro-1"] }
  ],
  lines: [
    {
      id: "metro-1",
      code: "1",
      name: "Line 1",
      mode: "metro",
      color: "#FFCD00",
      textColor: "#000000",
      operator: "test",
      capability: "estimated_segment",
      directions: [
        {
          id: "east",
          name: "Zéta",
          stopIds: ["station-a", "station-z"],
          geometry: {
            type: "LineString",
            coordinates: [
              [2.3, 48.8],
              [2.4, 48.9]
            ]
          }
        }
      ]
    }
  ]
};

describe("PRIM source adapter", () => {
  it("turns every mapped realtime call into a countdown and ignores journey identity", async () => {
    const result = await source(
      respond(
        payload("2026-08-31T12:00:00.000Z", [
          { stop: "a", arrival: "2026-08-31T12:00:40.000Z", note: "Métro à l'approche" },
          { stop: "b", departure: "2026-08-31T12:02:00.000Z" },
          { stop: "unmapped", arrival: "2026-08-31T12:03:00.000Z" }
        ]),
        { "retry-after": "120", "x-ratelimit-remaining": "998", "ratelimit-reset": "57031" }
      ),
      mapped
    ).poll();

    expect(result).toEqual({
      source: "prim",
      feedAt: Date.parse("2026-08-31T12:00:00.000Z"),
      receivedAt: Date.parse("2026-08-31T12:00:00.000Z"),
      quotaRemaining: 998,
      quotaResetAfterMs: 57_031_000,
      retryAfterMs: 120_000,
      predictions: [
        {
          lineId: "metro-1",
          stopId: "station-a",
          destinationStopId: "station-z",
          expectedAt: Date.parse("2026-08-31T12:00:40.000Z"),
          note: "approaching"
        },
        {
          lineId: "metro-1",
          stopId: "station-b",
          destinationStopId: "station-z",
          expectedAt: Date.parse("2026-08-31T12:02:00.000Z")
        }
      ]
    });
  });

  it("marks à quai calls as platform countdowns and prefers the arrival time", async () => {
    const result = await source(
      respond(
        payload("2026-08-31T12:00:00.000Z", [
          {
            stop: "a",
            arrival: "2026-08-31T12:00:05.000Z",
            departure: "2026-08-31T12:00:25.000Z",
            note: "Métro à quai"
          }
        ])
      ),
      mapped
    ).poll();

    expect(result.predictions).toEqual([
      expect.objectContaining({
        expectedAt: Date.parse("2026-08-31T12:00:05.000Z"),
        note: "at_platform"
      })
    ]);
  });

  it("resolves the destination from DestinationDisplay when DestinationRef is unmapped", async () => {
    const result = await source(
      respond(
        payload(
          "2026-08-31T12:00:00.000Z",
          [
            { stop: "a", arrival: "2026-08-31T12:01:00.000Z", display: "ZÉTA" },
            { stop: "b", arrival: "2026-08-31T12:02:00.000Z", display: "Nowhere" }
          ],
          { DestinationRef: { value: "unknown-terminus" } }
        )
      ),
      { ...mapped, terminusIndex: buildTerminusIndex(manifest) }
    ).poll();

    expect(result.predictions).toEqual([
      expect.objectContaining({ stopId: "station-a", destinationStopId: "station-z" })
    ]);
  });

  it("indexes each terminus by direction name and station name", () => {
    expect(buildTerminusIndex(manifest)).toEqual({
      "metro-1": { zeta: "station-z", "zeta terminus": "station-z" }
    });
  });

  it("never turns aimed-only calls into countdowns", async () => {
    const result = await source(
      respond(
        payload("2026-08-31T12:00:00.000Z", [{ stop: "a", aimed: "2026-08-31T12:01:00.000Z" }])
      ),
      mapped
    ).poll();

    expect(result.predictions).toEqual([]);
  });

  it("returns no countdowns, without failing, when no provider data is mapped", async () => {
    const result = await source(
      respond(
        payload("2026-08-31T12:00:00.000Z", [{ stop: "a", arrival: "2026-08-31T12:01:00.000Z" }])
      ),
      { lineIdMap: { anotherLine: "metro-1" }, stopIdMap: { a: "station-a" } }
    ).poll();

    expect(result.predictions).toEqual([]);
  });

  it("requests the unfiltered estimated timetable with the API key", async () => {
    let requestedUrl: unknown;
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = input;
      requestInit = init;
      return Promise.resolve(
        new Response(JSON.stringify(payload("2026-08-31T12:00:00.000Z", [])), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }) as unknown as typeof fetch;

    await source(fetchImpl).poll();

    expect(String(requestedUrl)).toBe("https://example.test/marketplace/estimated-timetable");
    expect(requestInit?.headers).toMatchObject({ apikey: "test-only" });
  });

  it("allows one retry 30 s after a request, never sooner", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const fetchImpl = respond(payload("2026-08-31T12:00:00.000Z", []));
    const adapter = source(fetchImpl, { clock: () => now });

    await adapter.poll();
    now = new Date("2026-08-31T12:00:29.999Z");
    await expect(adapter.poll()).rejects.toEqual(expect.any(PrimPollThrottledError));
    now = new Date("2026-08-31T12:00:30.000Z");
    await adapter.poll();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces quota failures without retrying", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response("quota", {
          status: 429,
          headers: { "retry-after": "90", "x-ratelimit-remaining": "0", "ratelimit-reset": "3600" }
        })
      )
    ) as unknown as typeof fetch;
    const adapter = source(fetchImpl);

    const failure: unknown = await adapter.poll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PrimHttpError);
    expect(failure).toMatchObject({
      statusCode: 429,
      quotaRemaining: 0,
      quotaResetAfterMs: 3_600_000
    });
    await expect(adapter.poll()).rejects.toEqual(expect.any(PrimPollThrottledError));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("captures receivedAt after the response body has arrived", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const fetchImpl = vi.fn(() => {
      now = new Date("2026-08-31T12:00:05.000Z");
      return Promise.resolve(
        new Response(JSON.stringify(payload("2026-08-31T12:00:00.000Z", [])), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }) as unknown as typeof fetch;

    const result = await source(fetchImpl, { clock: () => now }).poll();

    expect(result.receivedAt).toBe(Date.parse("2026-08-31T12:00:05.000Z"));
  });

  it("rejects oversized compressed and decoded responses", async () => {
    const compressed = source(
      vi.fn(() =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-length": "11", "content-type": "application/json" }
          })
        )
      ) as unknown as typeof fetch,
      { maxCompressedResponseBytes: 10 }
    );
    const decoded = source(respond({ Siri: { padding: "larger-than-ten-bytes" } }), {
      maxDecodedResponseBytes: 10
    });

    await expect(compressed.poll()).rejects.toMatchObject({
      stage: "compressed"
    } satisfies Partial<PrimResponseTooLargeError>);
    await expect(decoded.poll()).rejects.toMatchObject({
      stage: "decoded"
    } satisfies Partial<PrimResponseTooLargeError>);
  });

  it("aborts a PRIM request at the configured timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    ) as unknown as typeof fetch;

    await expect(source(fetchImpl, { requestTimeoutMs: 5 }).poll()).rejects.toEqual(
      expect.any(PrimRequestTimeoutError)
    );
  });

  it("rejects malformed JSON and responses without a valid provider timestamp", async () => {
    const malformed = source(
      vi.fn(() =>
        Promise.resolve(
          new Response("{broken", { status: 200, headers: { "content-type": "application/json" } })
        )
      ) as unknown as typeof fetch
    );
    const missingTimestamp = source(respond({ Siri: { ServiceDelivery: {} } }));

    await expect(malformed.poll()).rejects.toEqual(expect.any(PrimPayloadError));
    await expect(missingTimestamp.poll()).rejects.toEqual(expect.any(PrimPayloadError));
  });

  it("rejects an implausibly future provider timestamp", async () => {
    const adapter = source(
      respond(
        payload("2026-08-31T12:01:00.000Z", [{ stop: "a", arrival: "2026-08-31T12:02:00.000Z" }])
      )
    );

    await expect(adapter.poll()).rejects.toEqual(expect.any(PrimPayloadError));
  });
});
