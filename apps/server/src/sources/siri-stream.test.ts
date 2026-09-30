import { describe, expect, it } from "vitest";

import { readSiriStream, SiriStreamError } from "./siri-stream.js";

/** A body delivered in `size`-byte chunks, which can split characters and escapes. */
function body(text: string, size = 1_000_000): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    }
  });
}

const document = JSON.stringify({
  Siri: {
    ServiceDelivery: {
      ResponseTimestamp: "2026-09-28T17:00:00.000Z",
      EstimatedTimetableDelivery: [
        {
          ResponseTimestamp: "2026-09-28T17:00:01.000Z",
          EstimatedJourneyVersionFrame: [
            {
              EstimatedVehicleJourney: [
                { LineRef: { value: "metro" }, CallNote: 'Métro à quai {"x": [1]} \\ "quoted"' },
                { LineRef: { value: "bus" }, Calls: [[{}], []] }
              ]
            },
            { estimatedvehiclejourney: { LineRef: { value: "metro-2" } } }
          ]
        }
      ]
    }
  }
});

describe("SIRI stream reader", () => {
  it("extracts journeys and timestamps wherever the chunks split", async () => {
    const expected = JSON.parse(document) as {
      Siri: {
        ServiceDelivery: {
          EstimatedTimetableDelivery: {
            EstimatedJourneyVersionFrame: [{ EstimatedVehicleJourney: unknown[] }];
          }[];
        };
      };
    };
    const journeys = [
      ...(expected.Siri.ServiceDelivery.EstimatedTimetableDelivery[0]
        ?.EstimatedJourneyVersionFrame[0].EstimatedVehicleJourney ?? []),
      { LineRef: { value: "metro-2" } }
    ];
    for (const size of [1, 2, 3, 7, 64, 1_000_000]) {
      await expect(readSiriStream(body(document, size), 1e9, (value) => value)).resolves.toEqual({
        hasSiri: true,
        responseTimestamps: ["2026-09-28T17:00:00.000Z", "2026-09-28T17:00:01.000Z"],
        journeys
      });
    }
  });

  it("keeps only the journeys the callback returns", async () => {
    const result = await readSiriStream(body(document), 1e9, (value) => {
      const line = (value as { LineRef: { value: string } }).LineRef.value;
      return line.startsWith("metro") ? line : undefined;
    });
    expect(result.journeys).toEqual(["metro", "metro-2"]);
  });

  it("reports whether the document has a SIRI root", async () => {
    const result = await readSiriStream(body('{"Other": {"Siri": 1}}'), 1e9, () => undefined);
    expect(result.hasSiri).toBe(false);
  });

  it.each([
    ["truncated", document.slice(0, -3)],
    ["not an object", "[]"],
    ["unbalanced", '{"Siri": {]}'],
    ["trailing content", `${document} {}`],
    ["a broken journey", '{"Siri": {"EstimatedVehicleJourney": [{"LineRef": }]}}']
  ])("rejects %s input", async (_name, text) => {
    await expect(readSiriStream(body(text), 1e9, (value) => value)).rejects.toEqual(
      new SiriStreamError("malformed")
    );
  });

  it("stops reading a body larger than the limit", async () => {
    await expect(readSiriStream(body(document, 16), 100, () => undefined)).rejects.toEqual(
      new SiriStreamError("too_large")
    );
  });
});
