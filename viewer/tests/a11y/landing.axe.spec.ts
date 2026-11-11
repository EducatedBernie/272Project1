import { expect, type Page, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test.describe("landing page accessibility (axe-core)", () => {
  test("initial state", async ({ page }) => {
    await page.goto("/");
    await waitForLandingReady(page);

    const results = await axeForApp(page).analyze();

    expect(violationReport(results.violations)).toEqual([]);
  });

  test("after switching to Silent Board Work demo", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Silent Board Work/i }).click();
    await waitForLandingReady(page);

    const results = await axeForApp(page).analyze();

    expect(violationReport(results.violations)).toEqual([]);
  });

  test("after opening a spec-sheet row in the Reading Room", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Spec sheet/i }).click();
    await waitForLandingReady(page);

    const results = await axeForApp(page).analyze();

    expect(violationReport(results.violations)).toEqual([]);
  });

  test("hero badge copy is honest about MathML support", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("MathML output")).toBeVisible();
    await expect(page.getByText("MathML native")).toHaveCount(0);
  });
});

async function waitForLandingReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForFunction(
    () => document.querySelectorAll(".katex-mathml math").length > 0
  );
}

function axeForApp(page: Page) {
  return new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // reason: YouTube owns the embedded player document; Chalkboard verifies
    // the iframe's app-owned accessible name in the accessibility-tree tests.
    .exclude('iframe[src*="youtube.com"]')
    .exclude('iframe[src*="youtube-nocookie.com"]');
}

// Project the violation list down to the fields that actually matter in a
// failure message, so test output is readable and diffs are stable.
function violationReport(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]
) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target),
  }));
}
