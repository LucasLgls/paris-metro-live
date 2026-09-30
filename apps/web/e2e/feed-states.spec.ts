import { expect, test } from "@playwright/test";

import { drawnLineIds, drawnTrainCount } from "./train-layer.js";

test("provider outage keeps geography while removing trains", async ({ page }) => {
  await page.route("**/api/v1/status", async (route) => {
    await route.fulfill({
      json: {
        schemaVersion: 1,
        status: "unavailable",
        source: "fixture",
        generatedAt: new Date().toISOString(),
        sourceObservedAt: null,
        sourceAgeSeconds: null,
        pollIntervalSeconds: 15,
        supportedLines: 0,
        message: "Provider unavailable"
      }
    });
  });
  await page.goto("/");

  await expect(page.getByTestId("feed-status").getByRole("status")).toHaveText(
    "Transit provider unavailable"
  );
  await expect(page.getByTestId("transit-map")).toBeVisible();
  await expect(page.getByTestId("station-label")).toHaveCount(321);
  await expect(page.getByTestId("train-layer")).toHaveAttribute("data-train-count", "0");
});

test("a partial outage keeps usable lines and static network context", async ({ page }) => {
  await page.route("**/api/v1/status", async (route) => {
    const response = await route.fetch();
    const status = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...status, status: "degraded", message: "Partial coverage" } });
  });
  await page.goto("/");

  await expect(page.getByTestId("feed-status").getByRole("status")).toHaveText(
    "Live data degraded"
  );
  await expect(page.getByTestId("line-badge")).toHaveCount(16);
  await expect.poll(() => drawnTrainCount(page)).toBeGreaterThan(0);
});

test("a configured route-only line never shows a train", async ({ page }) => {
  await page.route("**/api/v1/network/manifest", async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as {
      lines: Array<{ id: string; capability: string }>;
    };
    const lines = manifest.lines.map((line) =>
      line.id === "metro-2" ? { ...line, capability: "unavailable" } : line
    );
    await route.fulfill({ json: { ...manifest, lines } });
  });
  await page.goto("/");

  await expect(page.locator('[data-testid="line-badge"][data-line-code="2"]')).toHaveCount(1);
  await expect.poll(() => drawnTrainCount(page)).toBeGreaterThan(0);
  expect(await drawnLineIds(page)).not.toContain("metro-2");
  await expect(page.locator('[data-testid="line-description"][data-line-code="2"]')).toContainText(
    "Route only"
  );
});

test("a paused line keeps its trains dimmed and says live data is paused", async ({ page }) => {
  await page.route("**/api/v1/vehicles/stream**", (route) => route.abort());
  await page.route("**/api/v1/vehicles", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as {
      lines: Array<{ lineId: string; state: string; since?: string }>;
      trains: Array<{ lineId: string; state: string; stateSince: string }>;
    };
    const since = new Date().toISOString();
    await route.fulfill({
      json: {
        ...snapshot,
        lines: snapshot.lines.map((line) =>
          line.lineId === "metro-1" ? { ...line, state: "frozen", since } : line
        ),
        trains: snapshot.trains.map((train) =>
          train.lineId === "metro-1" ? { ...train, state: "frozen", stateSince: since } : train
        )
      }
    });
  });
  await page.goto("/");

  await expect(page.locator('[data-testid="line-description"][data-line-code="1"]')).toContainText(
    "Live data paused"
  );
  await expect.poll(() => drawnTrainCount(page, "data-frozen-count")).toBeGreaterThan(0);
  expect(await drawnTrainCount(page)).toBeGreaterThan(
    await drawnTrainCount(page, "data-frozen-count")
  );
});

test("the overnight pause says there is no Métro service", async ({ page }) => {
  await page.route("**/api/v1/status", async (route) => {
    const response = await route.fetch();
    const status = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: { ...status, status: "no_service", message: "No Métro service at this hour" }
    });
  });
  await page.goto("/");

  await expect(page.getByTestId("feed-status").getByRole("status")).toHaveText(
    "No Métro service at this hour"
  );
  await expect(page.getByTestId("transit-map")).toBeVisible();
});
