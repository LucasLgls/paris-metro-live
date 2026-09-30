import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the geographic map meets automated WCAG A and AA checks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: /Geographic map of Paris/ })).toBeVisible();
  await expect(page.getByTestId("line-description")).toHaveCount(16);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.flatMap((node) => node.target)
    }))
  ).toEqual([]);
});

test("the data credits are directly reachable and accessible", async ({ page }) => {
  await page.goto("/credits");
  await expect(page).toHaveTitle("Data credits — Paris Transit Live");
  await expect(page.getByRole("heading", { name: "Data credits", level: 1 })).toBeVisible();
  await expect(page.getByText(/not reported GPS locations/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "OpenStreetMap contributors" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test("reduced motion removes interface animation delays", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const motion = await page.getByRole("button", { name: "Zoom in" }).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDuration: Number.parseFloat(style.animationDuration),
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      transitionDuration: Number.parseFloat(style.transitionDuration)
    };
  });

  expect(motion.reduced).toBe(true);
  expect(motion.animationDuration).toBeLessThanOrEqual(0.001);
  expect(motion.transitionDuration).toBeLessThanOrEqual(0.001);
});
