import { expect, type Page, test } from "@playwright/test";

test.describe("landing accessibility tree shape", () => {
  test("landing landmarks and hero tree match", async ({ page }) => {
    await page.goto("/");
    await waitForLandingTreeReady(page);

    await expect(page.locator('a[href="#main-content"]')).toMatchAriaSnapshot({
      name: "skip-link.aria.yml",
    });
    await expect(page.getByRole("main")).toHaveAttribute("id", "main-content");
    await expect(page.locator("main > section").first()).toMatchAriaSnapshot({
      name: "landing-hero.aria.yml",
    });
  });

  test("output and demo control trees match", async ({ page }) => {
    await page.goto("/");
    await waitForLandingTreeReady(page);

    await expect(
      page.getByRole("tablist", { name: "Chalkboard output types" })
    ).toMatchAriaSnapshot({
      name: "output-tablist.aria.yml",
    });
    await expect(page.locator("#proof-panel-equations")).toMatchAriaSnapshot({
      name: "equations-panel.aria.yml",
    });
    await expect(
      page.getByRole("tablist", { name: "Demo lectures" })
    ).toMatchAriaSnapshot({
      name: "demo-tabs.aria.yml",
    });
  });

  test("demo viewer tree after Silent Board Work selection", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Silent Board Work/i }).click();
    await waitForLandingTreeReady(page);

    await expect(
      page.getByRole("tablist", { name: "Demo lectures" })
    ).toMatchAriaSnapshot({
      name: "demo-tabs-silent.aria.yml",
    });
    await expect(page.locator("#live [role='tabpanel'] > p")).toMatchAriaSnapshot({
      name: "demo-silent-summary.aria.yml",
    });
    await expect(page.locator("#live iframe")).toHaveAttribute("title", /\S/);
    await expect(page.locator("#live [role='status']")).toMatchAriaSnapshot({
      name: "demo-live-status.aria.yml",
    });
  });
});

async function waitForLandingTreeReady(page: Page) {
  // Embedded video keeps network activity alive; wait for the UI below instead.
  // Wait for KaTeX to hydrate so equations appear in the tree.
  await page.waitForFunction(
    () => document.querySelectorAll(".katex-mathml math").length > 0
  );
  await page.waitForFunction(() => {
    const frame = document.querySelector("#live iframe");
    return frame?.getAttribute("title")?.trim();
  });
}
