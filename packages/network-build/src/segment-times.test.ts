import { describe, expect, it } from "vitest";

import { computeSegmentTimes, parseGtfsTime } from "./segment-times.ts";

describe("parseGtfsTime", () => {
  it("parses HH:MM:SS to seconds", () => {
    expect(parseGtfsTime("00:01:30")).toBe(90);
  });

  it("supports hours past midnight (>= 24)", () => {
    expect(parseGtfsTime("25:30:00")).toBe(25 * 3600 + 30 * 60);
  });
});

describe("computeSegmentTimes", () => {
  const directions = [
    { id: "east", stopIds: ["a", "b", "c"] },
    { id: "west", stopIds: ["c", "b", "a"] }
  ];
  const stopIdByGtfsId = {
    "IDFM:1": "a",
    "IDFM:2": "b",
    "IDFM:3": "c",
    "IDFM:4": "d"
  };

  it("takes the median run time per segment and reads dwell from the from-stop", () => {
    const result = computeSegmentTimes({
      topologyVersion: "test-v1",
      directions,
      stopIdByGtfsId,
      stopTimesByTrip: {
        // eastbound: a→b run 60, then b→c run 60 (dwell at b = 10)
        t1: [
          { stopSequence: 0, stopId: "IDFM:1", arrival: 0, departure: 0 },
          { stopSequence: 1, stopId: "IDFM:2", arrival: 60, departure: 70 },
          { stopSequence: 2, stopId: "IDFM:3", arrival: 130, departure: 130 }
        ],
        // eastbound: a→b run 80 (dwell at b = 10), b→c run 60
        t2: [
          { stopSequence: 0, stopId: "IDFM:1", arrival: 0, departure: 0 },
          { stopSequence: 1, stopId: "IDFM:2", arrival: 80, departure: 90 },
          { stopSequence: 2, stopId: "IDFM:3", arrival: 150, departure: 150 }
        ],
        // westbound: c→b run 100 (dwell at b = 10), b→a run 60
        t3: [
          { stopSequence: 0, stopId: "IDFM:3", arrival: 0, departure: 0 },
          { stopSequence: 1, stopId: "IDFM:2", arrival: 100, departure: 110 },
          { stopSequence: 2, stopId: "IDFM:1", arrival: 170, departure: 170 }
        ]
      }
    });

    expect(result.segments.east).toEqual([
      { fromStopId: "a", toStopId: "b", runSeconds: 70, dwellSeconds: 0 },
      { fromStopId: "b", toStopId: "c", runSeconds: 60, dwellSeconds: 10 }
    ]);
    expect(result.segments.west?.[0]).toEqual({
      fromStopId: "c",
      toStopId: "b",
      runSeconds: 100,
      dwellSeconds: 0
    });
  });

  it("throws when a segment has no observed trips", () => {
    expect(() =>
      computeSegmentTimes({
        topologyVersion: "test-v1",
        directions: [{ id: "east", stopIds: ["a", "b", "c"] }],
        stopIdByGtfsId,
        stopTimesByTrip: {
          // only covers a→b, never b→c
          t1: [
            { stopSequence: 0, stopId: "IDFM:1", arrival: 0, departure: 0 },
            { stopSequence: 1, stopId: "IDFM:2", arrival: 60, departure: 70 }
          ]
        }
      })
    ).toThrow(/b.*c|segment/i);
  });

  it("indexes repeated stops by segment occurrence", () => {
    const result = computeSegmentTimes({
      topologyVersion: "loop-v1",
      directions: [{ id: "loop", stopIds: ["a", "b", "c", "b", "d"] }],
      stopIdByGtfsId,
      stopTimesByTrip: {
        loop: [
          { stopSequence: 0, stopId: "IDFM:1", arrival: 0, departure: 0 },
          { stopSequence: 1, stopId: "IDFM:2", arrival: 60, departure: 70 },
          { stopSequence: 2, stopId: "IDFM:3", arrival: 130, departure: 140 },
          { stopSequence: 3, stopId: "IDFM:2", arrival: 230, departure: 240 },
          { stopSequence: 4, stopId: "IDFM:4", arrival: 360, departure: 360 }
        ]
      }
    });

    expect(result.segments.loop).toEqual([
      { fromStopId: "a", toStopId: "b", runSeconds: 60, dwellSeconds: 0 },
      { fromStopId: "b", toStopId: "c", runSeconds: 60, dwellSeconds: 10 },
      { fromStopId: "c", toStopId: "b", runSeconds: 90, dwellSeconds: 10 },
      { fromStopId: "b", toStopId: "d", runSeconds: 120, dwellSeconds: 10 }
    ]);
  });
});
