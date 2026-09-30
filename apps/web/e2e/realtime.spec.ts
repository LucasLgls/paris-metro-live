import { expect, test } from "@playwright/test";

import { drawnLineIds, drawnTrainCount } from "./train-layer.js";

test("a valid stream update draws estimated trains", async ({ page, request }) => {
  const response = await request.get("/api/v1/vehicles");
  expect(response.ok()).toBe(true);
  const liveSnapshot = (await response.json()) as Record<string, unknown>;

  await page.route("**/api/v1/vehicles", async (route) => {
    await route.fulfill({ json: { ...liveSnapshot, sequence: 0, trains: [] } });
  });
  await page.addInitScript(() => {
    const sources = new Set<FakeEventSource>();

    class FakeEventSource {
      static readonly CLOSED = 2;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readonly url: string;
      readonly withCredentials = false;
      readyState = FakeEventSource.CONNECTING;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

      constructor(url: string | URL) {
        this.url = String(url);
        sources.add(this);
        queueMicrotask(() => {
          this.readyState = FakeEventSource.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
        if (!listener) return;
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
        if (listener) this.listeners.get(type)?.delete(listener);
      }

      close() {
        this.readyState = FakeEventSource.CLOSED;
        sources.delete(this);
      }

      dispatch(data: string) {
        const event = new MessageEvent("vehicles", { data });
        for (const listener of this.listeners.get("vehicles") ?? []) {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent(event);
        }
      }
    }

    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    Object.defineProperty(window, "__emitTransitTrains", {
      configurable: true,
      value: (data: string) => {
        for (const source of sources) source.dispatch(data);
      }
    });
    Object.defineProperty(window, "__transitTrainSubscriberCount", {
      configurable: true,
      value: () => sources.size
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("train-layer")).toHaveAttribute("data-train-count", "0");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __transitTrainSubscriberCount: () => number;
          }
        ).__transitTrainSubscriberCount()
      )
    )
    .toBeGreaterThan(0);
  await page.evaluate((snapshot) => {
    const emit = (window as unknown as { __emitTransitTrains: (data: string) => void })
      .__emitTransitTrains;
    emit(JSON.stringify(snapshot));
  }, liveSnapshot);

  await expect.poll(() => drawnTrainCount(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await drawnLineIds(page)).length).toBeGreaterThan(1);
  await expect(page.getByTestId("map-summary")).toContainText(
    /Live data healthy\. [1-9]\d* visible train/
  );
});
