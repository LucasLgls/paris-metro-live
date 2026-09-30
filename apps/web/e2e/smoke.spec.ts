import { expect, test } from "@playwright/test";

import { drawnTrainCount } from "./train-layer.js";

test("the complete Métro network uses only local runtime assets", async ({ page, request }) => {
  const networkResponse = await request.get("/api/v1/network/manifest");
  expect(networkResponse.ok()).toBe(true);
  const network = (await networkResponse.json()) as {
    lines: Array<{ id: string; directions: Array<{ stopIds: string[] }> }>;
  };
  expect(network.lines).toHaveLength(16);
  expect(network.lines.find((line) => line.id === "metro-1")?.directions[0]?.stopIds).toHaveLength(
    25
  );

  const externalOrigins = new Set<string>();
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
      externalOrigins.add(url.origin);
    }
  });

  const tileRequest = page.waitForResponse((response) =>
    response.url().includes("paris-metro-20260909.pmtiles")
  );
  await page.goto("/");
  const map = page.getByTestId("transit-map");
  await expect(map).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  expect((await tileRequest).ok()).toBe(true);
  await expect(page.getByTestId("line-badge")).toHaveCount(16);
  await expect(map).toHaveClass(/map-shell--overview/);
  const mapBox = await map.boundingBox();
  const chateletBox = await page.locator('[data-stop-id="idfm-71264"]').boundingBox();
  expect(mapBox).not.toBeNull();
  expect(chateletBox).not.toBeNull();
  if (mapBox && chateletBox) {
    const mapCentre = [mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2] as const;
    const chateletCentre = [
      chateletBox.x + chateletBox.width / 2,
      chateletBox.y + chateletBox.height / 2
    ] as const;
    expect(Math.abs(chateletCentre[0] - mapCentre[0])).toBeLessThan(mapBox.width * 0.12);
    expect(Math.abs(chateletCentre[1] - mapCentre[1])).toBeLessThan(mapBox.height * 0.12);
  }
  const overviewBadge = page.getByTestId("line-badge").filter({ visible: true }).first();
  expect(await overviewBadge.evaluate((badge) => badge.getBoundingClientRect().height)).toBe(19);
  await expect.poll(() => drawnTrainCount(page)).toBeGreaterThan(0);
  expect(
    await page.getByTestId("line-badge").evaluateAll((badges) =>
      badges.map((badge) => ({
        code: badge.textContent,
        background: (badge as HTMLElement).style.backgroundColor,
        foreground: (badge as HTMLElement).style.color
      }))
    )
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "1", background: "rgb(255, 190, 0)" }),
      expect.objectContaining({ code: "3bis", background: "rgb(130, 200, 230)" }),
      expect.objectContaining({ code: "7bis", background: "rgb(130, 220, 115)" }),
      expect.objectContaining({ code: "14", background: "rgb(100, 0, 130)" })
    ])
  );
  expect([...externalOrigins]).toEqual([]);
});
