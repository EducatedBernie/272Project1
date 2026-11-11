import { expect, test } from "@playwright/test";
import { attachVirtualReader, waitForVirtualReader } from "./setup-virtual-sr";

test.beforeEach(async ({ page }) => {
  await attachVirtualReader(page);
});

test("a rendered display equation is announced as math, not as raw LaTeX", async ({ page }) => {
  await page.goto("/");
  await waitForVirtualReader(page);
  // The TabbedProof Equations panel renders a known DisplayLatex equation.
  await page.getByRole("tab", { name: /Equations/i }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".katex-mathml math").length > 0
  );

  const spoken = await page.evaluate(async () => {
    const math = document.querySelector(".katex-mathml math");
    if (!math) throw new Error("Could not find hydrated MathML");
    if (!window.virtual) throw new Error("Virtual screen reader did not attach");

    await window.virtual.start({ container: math });
    const phrases = [await window.virtual.lastSpokenPhrase()];
    for (let i = 0; i < 12; i++) {
      await window.virtual.next();
      phrases.push(await window.virtual.lastSpokenPhrase());
    }
    await window.virtual.stop();
    return phrases;
  });

  // The exact prose varies by reader model; pin only the behavior that matters.
  const joined = spoken.join(" ").toLowerCase();
  expect(joined).toMatch(/equation|math/);
  expect(joined).toMatch(/=|equal|equals/);
  expect(joined).not.toMatch(/backslash|ddot|vec|frac/);
});

test("playing the demo does not stack two live-region announcements", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => !!document.querySelector('[role="tabpanel"] iframe, [role="tabpanel"] video')
  );

  const liveRegions = await page.evaluate(() => {
    const panel = document.querySelector('#live [role="tabpanel"]');
    if (!panel) throw new Error("Could not find active demo tabpanel");

    return Array.from(panel.querySelectorAll("[aria-live]")).map((el) => ({
      live: el.getAttribute("aria-live"),
      role: el.getAttribute("role"),
    }));
  });

  const announcing = liveRegions.filter(
    (region) => region.live === "polite" || region.live === "assertive"
  );
  expect(announcing).toEqual([{ live: "polite", role: "status" }]);
});

test("transcript live region does not announce raw LaTeX source", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /Silent Board Work/i }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#live [role="status"]');
    return status?.textContent?.includes("divide through");
  });

  const statusText = await page.locator('#live [role="status"]').textContent();
  const seekLabel = await page
    .locator('#live button[aria-label*="divide through"]')
    .first()
    .getAttribute("aria-label");

  expect(statusText).toBeTruthy();
  expect(statusText).not.toMatch(/\\frac|\\left|\\right|backslash|\$/);
  expect(seekLabel).toBeTruthy();
  expect(seekLabel).not.toMatch(/\\frac|\\left|\\right|backslash|\$/);
});
