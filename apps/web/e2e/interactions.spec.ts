import { expect, test } from "@playwright/test";

test("zoom controls are keyboard operable 44 pixel targets", async ({ page }) => {
  await page.goto("/");
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  await expect(zoomIn).toBeVisible();
  await expect(zoomOut).toBeVisible();
  expect(await zoomIn.evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
  expect(await zoomIn.evaluate((element) => element.getBoundingClientRect().height)).toBe(44);

  await zoomIn.focus();
  await zoomIn.press("Enter");
  await expect(zoomIn).toBeFocused();
});

test("semantic zoom reveals more station names", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("station-label")).toHaveCount(321);
  const shownLabels = page.locator('[data-testid="station-label"]:visible');
  const overviewCount = await shownLabels.count();
  expect(overviewCount).toBeGreaterThan(0);
  const revealedCloseLabels = page.locator(".station-label--close:not(.is-hidden)");
  await expect(revealedCloseLabels).toHaveCount(0);

  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  for (let index = 0; index < 4; index += 1) {
    await zoomIn.click();
    await page.waitForTimeout(250);
  }
  await expect.poll(() => revealedCloseLabels.count()).toBeGreaterThan(0);
});

test("hover previews a line and click locks the highlight", async ({ page }) => {
  await page.goto("/");
  const map = page.locator("#metro-map");
  const lineBadge = page.locator('[data-testid="line-badge"][data-line-code="1"]');
  await expect(lineBadge).toBeVisible();
  const badgeBox = await lineBadge.boundingBox();
  const mapBox = await map.boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(mapBox).not.toBeNull();
  if (!badgeBox || !mapBox) return;

  const linePoint = {
    x: badgeBox.x + badgeBox.width / 2,
    y: badgeBox.y + badgeBox.height / 2
  };
  const emptyPoint = { x: mapBox.x + 8, y: mapBox.y + 8 };
  await page.mouse.move(linePoint.x, linePoint.y);
  await expect.poll(() => map.getAttribute("data-active-line-id")).not.toBe("");
  const highlightedLineId = await map.getAttribute("data-active-line-id");
  expect(highlightedLineId).toMatch(/^metro-/);

  await page.mouse.click(linePoint.x, linePoint.y);
  await page.mouse.move(emptyPoint.x, emptyPoint.y);
  await expect(map).toHaveAttribute("data-active-line-id", highlightedLineId ?? "");

  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await expect(map).toHaveAttribute("data-active-line-id", "");
});
