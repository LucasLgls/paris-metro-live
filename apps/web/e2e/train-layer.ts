import type { Page } from "@playwright/test";

/** Trains drawn on the map canvas, as reported by its test attributes. */
export async function drawnTrainCount(
  page: Page,
  attribute: "data-train-count" | "data-frozen-count" = "data-train-count"
): Promise<number> {
  return Number((await page.getByTestId("train-layer").getAttribute(attribute)) ?? "0");
}

export async function drawnLineIds(page: Page): Promise<string[]> {
  const value = await page.getByTestId("train-layer").getAttribute("data-line-ids");
  return (value ?? "").split(" ").filter(Boolean);
}
