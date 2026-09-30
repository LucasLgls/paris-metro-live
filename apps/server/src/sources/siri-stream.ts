const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_OBJECT = 123;
const CLOSE_OBJECT = 125;
const OPEN_ARRAY = 91;
const CLOSE_ARRAY = 93;
const COMMA = 44;

const journeyKey = "estimatedvehiclejourney";
const timestampKey = "responsetimestamp";

export class SiriStreamError extends Error {
  constructor(readonly reason: "too_large" | "malformed") {
    super(
      reason === "too_large" ? "SIRI response is too large" : "SIRI response is not valid JSON"
    );
    this.name = "SiriStreamError";
  }
}

export type SiriStreamResult<T> = {
  hasSiri: boolean;
  responseTimestamps: string[];
  journeys: T[];
};

/** An open object or array; `key` is the lower-cased key whose value is being read. */
type Frame = { array: boolean; key: string | undefined; journeys: boolean };

/**
 * Scans SIRI JSON text chunk by chunk. Structure is tracked character by character; each
 * `EstimatedVehicleJourney` object is cut out, parsed on its own, and handed to `onJourney`, so only
 * the journeys it keeps stay in memory. Keys match case-insensitively, as SIRI producers vary.
 */
class SiriScanner<T> {
  private readonly stack: Frame[] = [];
  private readonly timestamps: string[] = [];
  private readonly journeys: T[] = [];
  private hasSiri = false;
  private rootSeen = false;
  private expectKey = false;
  private inString = false;
  private escaped = false;
  /** Parts of the current key or timestamp string; undefined when its content is not needed. */
  private stringParts: string[] | undefined;
  private capture:
    | { depth: number; inString: boolean; escaped: boolean; parts: string[] }
    | undefined;

  constructor(private readonly onJourney: (journey: unknown) => T | undefined) {}

  write(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      index = this.capture ? this.scanCapture(chunk, index) : this.scanStructure(chunk, index);
    }
  }

  end(): SiriStreamResult<T> {
    if (!this.rootSeen || this.stack.length > 0 || this.inString || this.capture) {
      throw new SiriStreamError("malformed");
    }
    return { hasSiri: this.hasSiri, responseTimestamps: this.timestamps, journeys: this.journeys };
  }

  private scanStructure(chunk: string, start: number): number {
    let index = start;
    if (this.inString) return this.scanString(chunk, index);
    const code = chunk.charCodeAt(index);
    const top = this.stack.at(-1);
    if (code === QUOTE) {
      const needed =
        top !== undefined && !top.array && (this.expectKey || top.key === timestampKey);
      this.stringParts = needed ? [] : undefined;
      this.inString = true;
      return this.scanString(chunk, index + 1);
    }
    if (code === OPEN_OBJECT) {
      if (!top && this.rootSeen) throw new SiriStreamError("malformed");
      this.rootSeen = true;
      if (top && ((top.array && top.journeys) || (!top.array && top.key === journeyKey))) {
        this.capture = { depth: 0, inString: false, escaped: false, parts: [] };
        return this.scanCapture(chunk, index);
      }
      this.stack.push({ array: false, key: undefined, journeys: false });
      this.expectKey = true;
    } else if (code === OPEN_ARRAY) {
      if (!top) throw new SiriStreamError("malformed");
      this.stack.push({
        array: true,
        key: undefined,
        journeys: !top.array && top.key === journeyKey
      });
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      if (top?.array !== (code === CLOSE_ARRAY)) throw new SiriStreamError("malformed");
      this.stack.pop();
      this.expectKey = false;
    } else if (code === COMMA) {
      this.expectKey = top !== undefined && !top.array;
    } else if (!top && code > 32) {
      throw new SiriStreamError("malformed");
    }
    index += 1;
    return index;
  }

  private scanString(chunk: string, start: number): number {
    let index = start;
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);
      if (this.escaped) this.escaped = false;
      else if (code === BACKSLASH) this.escaped = true;
      else if (code === QUOTE) break;
      index += 1;
    }
    this.stringParts?.push(chunk.slice(start, index));
    if (index === chunk.length) return index;
    this.inString = false;
    if (this.stringParts) this.finishString(this.stringParts.join(""));
    this.stringParts = undefined;
    return index + 1;
  }

  private finishString(raw: string): void {
    let value: string;
    try {
      value = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
    } catch {
      throw new SiriStreamError("malformed");
    }
    const top = this.stack.at(-1);
    if (!top) return;
    if (this.expectKey) {
      top.key = value.toLowerCase();
      this.expectKey = false;
      if (this.stack.length === 1 && top.key === "siri") this.hasSiri = true;
    } else if (top.key === timestampKey) {
      this.timestamps.push(value);
    }
  }

  private scanCapture(chunk: string, start: number): number {
    const capture = this.capture;
    if (!capture) return start;
    let index = start;
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);
      if (capture.inString) {
        if (capture.escaped) capture.escaped = false;
        else if (code === BACKSLASH) capture.escaped = true;
        else if (code === QUOTE) capture.inString = false;
      } else if (code === QUOTE) {
        capture.inString = true;
      } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
        capture.depth += 1;
      } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
        capture.depth -= 1;
        if (capture.depth === 0) {
          capture.parts.push(chunk.slice(start, index + 1));
          this.capture = undefined;
          this.finishJourney(capture.parts.join(""));
          return index + 1;
        }
      }
      index += 1;
    }
    capture.parts.push(chunk.slice(start));
    return index;
  }

  private finishJourney(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SiriStreamError("malformed");
    }
    const kept = this.onJourney(value);
    if (kept !== undefined) this.journeys.push(kept);
  }
}

/** Reads a SIRI response body with `SiriScanner`, rejecting bodies larger than `maxBytes`. */
export async function readSiriStream<T>(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onJourney: (journey: unknown) => T | undefined
): Promise<SiriStreamResult<T>> {
  const scanner = new SiriScanner(onJourney);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new SiriStreamError("too_large");
      scanner.write(decoder.decode(chunk.value, { stream: true }));
    }
    scanner.write(decoder.decode());
    return scanner.end();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}
