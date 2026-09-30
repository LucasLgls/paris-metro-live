import { expect, test } from "@playwright/test";

test("unknown paths redirect to the map", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/no-such-page");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("region", { name: /Geographic map of Paris/ })).toBeVisible();
  await expect(page.getByTestId("line-badge")).toHaveCount(16);
  expect(pageErrors).toEqual([]);
});
