# Accessibility Testing — Layered CI Coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle source-grep `accessibility-contract.test.ts` with three layers of real accessibility coverage that run in CI without anyone owning a copy of NVDA/JAWS: (1) axe-core violation scanning of the rendered DOM, (2) accessibility-tree snapshots for structural regressions, (3) a virtual screen reader walking the equation rendering path. End state: a PR that breaks an aria-label or wrecks the MathML output gets caught before it merges.

**Why these three layers:** Axe catches the things WCAG rule engines know about (~57% of issues per Deque's own numbers — missing alt, contrast, role/state mismatches). AT-tree snapshots catch structural drift (a heading dropped, a tab role flipped, an accessible name lost). The virtual screen reader is the only one of the three that actually models how an AT user *experiences* the page — reading order, live-region cadence, MathML being read as math vs as element names. Together they catch ~80% of the surface area, leaving a quarterly human pass for the rest.

**Tech Stack:** `@playwright/test` (already a peer dep of `eslint-config-next` chain via lighthouse but not installed standalone), `@axe-core/playwright`, `@guidepup/virtual-screen-reader`, Next.js 16 dev server.

**Out of scope:** Real NVDA-on-Windows CI via `@guidepup/playwright` + Windows runners. Worth doing later; not in this plan because (a) Windows runner minutes are expensive and (b) the virtual SR catches the same class of bugs cheaper. Decision to revisit before paid launch.

---

## Files touched

- **Delete:** `viewer/lib/accessibility-contract.test.ts` — entirely source-grep, gives false confidence.
- **Create:** `viewer/playwright.config.ts` — Playwright config with `webServer` block that boots `next dev` on port 3001 (avoid stomping on a running dev server on 3000).
- **Create:** `viewer/tests/a11y/landing.axe.spec.ts` — axe scan of `/` in default state and after demo-tab activation.
- **Create:** `viewer/tests/a11y/landing.tree.spec.ts` — AT-tree snapshot of `/` for structural regressions.
- **Create:** `viewer/tests/a11y/equation-reading.spec.ts` — virtual screen reader walking KaTeX-rendered equations and asserting on spoken phrases.
- **Create:** `viewer/tests/a11y/__snapshots__/` — Playwright AT-tree snapshots land here automatically on first run.
- **Modify:** `viewer/package.json` — add deps + `test:a11y` script + `test:all` aggregate.
- **Modify:** `viewer/.gitignore` — add `playwright-report/` and `test-results/`.
- **Modify:** `viewer/eslint.config.mjs` — add `tests/**` and `playwright-report/**` to ignores.
- **Keep as-is:** `viewer/lib/*.test.ts` (the rest) — they're behavioral unit tests on real logic, leave them. The `node:test`-runner-via-`tsx` command and the `lib/**/*.test.ts` glob remain unchanged.

## Design decisions

- **Playwright tests live in `viewer/tests/a11y/`, not `lib/`.** The existing `npm test` glob (`lib/**/*.test.ts`) excludes them so the two runners stay separate. `npm run test:a11y` runs Playwright; `npm run test:all` runs both.
- **Dev server port 3001 for tests.** Avoids the "is something running on 3000" race when devs run `npm test` mid-session. Playwright's `webServer.reuseExistingServer` is set to `true` so a manually-started `next dev -p 3001` is reused.
- **Single browser (Chromium) in CI.** WebKit/Firefox AT trees are similar enough that one is enough for regression coverage; multi-browser belongs in a separate nightly job, not per-PR.
- **Snapshots are checked in.** Reviewers read AT-tree diffs in the PR. If a diff is intentional, run `npm run test:a11y -- --update-snapshots` and commit.
- **Virtual screen reader runs in the browser via `page.evaluate`.** The `@guidepup/virtual-screen-reader` package is browser-compatible; loading it into the Playwright page via a `<script>` injection (or via `page.addInitScript` reading from `node_modules`) lets it walk the actual rendered DOM (post-KaTeX-useEffect-hydration) instead of jsdom-mocked output. This catches the SSR/no-JS race for equations that a jsdom-only test would miss.
- **No `axe.disableRules`.** If axe complains about a real violation, fix the page; don't silence the rule. The only exception allowed in this plan is `color-contrast-enhanced` (AAA-only), which is documented in the test file with a `// reason:` comment.
- **No fixture lecture data shipped to tests.** The landing page reads `/demo/<id>.json` from `viewer/public/demo/` which already exists in the repo. Tests use those real fixtures.

---

## Task 1: Install dependencies

**Files:** `viewer/package.json`, `viewer/package-lock.json`

- [ ] **Step 1: Install Playwright + axe + virtual SR**

From the `viewer/` directory:

```sh
npm install --save-dev \
  @playwright/test@^1.50.0 \
  @axe-core/playwright@^4.10.0 \
  @guidepup/virtual-screen-reader@^0.31.0
npx playwright install --with-deps chromium
```

`--with-deps` only installs OS deps on Linux; on macOS it's a no-op. Pin majors via `^` so future minor bumps are taken automatically.

- [ ] **Step 2: Verify installs**

```sh
npx playwright --version    # expect: Version 1.50.x or higher
node -e "require('@axe-core/playwright')" && echo ok
node -e "require('@guidepup/virtual-screen-reader')" && echo ok
```

If any command errors, stop and check the npm log — don't proceed with stale installs.

## Task 2: Configure Playwright

**Files:** `viewer/playwright.config.ts` (new), `viewer/.gitignore` (modify), `viewer/eslint.config.mjs` (modify)

- [ ] **Step 1: Write `viewer/playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/a11y",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3001",
    url: "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

The `--port 3001` flag survives the existing `npm run dev` script because Next.js passes through unrecognized args to its binary.

- [ ] **Step 2: Update `viewer/.gitignore`**

Append:

```
# Playwright
/playwright-report/
/test-results/
/playwright/.cache/
```

- [ ] **Step 3: Update `viewer/eslint.config.mjs`**

Add `"tests/**"`, `"playwright-report/**"`, `"test-results/**"` to the `globalIgnores([...])` array. Playwright snapshots are auto-generated and would otherwise fail ESLint.

## Task 3: Layer 1 — axe-core violation scanning

**Files:** `viewer/tests/a11y/landing.axe.spec.ts` (new)

- [ ] **Step 1: Write the axe spec**

```ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test.describe("landing page accessibility (axe-core)", () => {
  test("initial state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violationReport(results.violations)).toEqual([]);
  });

  test("after switching to Silent Board Work demo", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Silent Board Work/i }).click();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violationReport(results.violations)).toEqual([]);
  });

  test("after opening a spec-sheet row in the Reading Room", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Spec sheet/i }).click();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violationReport(results.violations)).toEqual([]);
  });
});

// Project the violation list down to the fields that actually matter in a
// failure message, so test output is readable and diffs are stable.
function violationReport(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target),
  }));
}
```

- [ ] **Step 2: Run it and triage**

```sh
cd viewer && npx playwright test landing.axe.spec.ts
```

This *will* fail the first time. Capture the violation list and decide for each one:

- **Real violation** → fix the source. Likely candidates: any remaining `<em>` used purely for color emphasis (axe rule `decorative-emphasis` is not standard but `aria-required-attr` and `color-contrast` will catch others), the YouTube iframe's `title` attribute being set async via `onReady` (axe scans before `onReady` fires — use `await page.waitForFunction(() => !!document.querySelector('iframe[title]:not([title=""])'))` to wait for it).
- **Known limitation we accept** → add to a `knownIssues` allowlist with a `// reason:` comment AND a linked issue/ADR. Do NOT silently exclude rules.

Do not move on until the three tests are green.

## Task 4: Layer 2 — accessibility-tree snapshots

**Files:** `viewer/tests/a11y/landing.tree.spec.ts` (new), `viewer/tests/a11y/__snapshots__/` (auto-created)

- [ ] **Step 1: Write the snapshot spec**

```ts
import { test, expect } from "@playwright/test";

test.describe("landing accessibility tree shape", () => {
  test("landing tree matches snapshot", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Wait for KaTeX to hydrate so equations appear in the tree.
    await page.waitForFunction(
      () => document.querySelectorAll(".katex-mathml").length > 0
    );
    const tree = await page.accessibility.snapshot({ interestingOnly: true });
    expect(JSON.stringify(tree, null, 2)).toMatchSnapshot("landing-tree.json");
  });

  test("demo viewer tree after Silent Board Work selection", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: /Silent Board Work/i }).click();
    await page.waitForLoadState("networkidle");
    const demoSection = await page.locator("#live").elementHandle();
    const tree = await page.accessibility.snapshot({
      interestingOnly: true,
      root: demoSection!,
    });
    expect(JSON.stringify(tree, null, 2)).toMatchSnapshot("demo-silent-tree.json");
  });
});
```

- [ ] **Step 2: Generate the baseline snapshots**

```sh
cd viewer && npx playwright test landing.tree.spec.ts --update-snapshots
```

- [ ] **Step 3: Eyeball the snapshots before committing**

Open `viewer/tests/a11y/__snapshots__/landing-tree.json` and verify:

1. The `<main id="main-content">` is at the top of the tree with `role: "main"`.
2. The skip link appears as `link "Skip to main content"` (not buried, not duplicated).
3. The hero `<h1>` reads as `heading "Lecture captions that read the board." level=1`.
4. The demo-lecture tablist reads as `tablist "Demo lectures"` with five `tab` children, exactly one `selected: true`.
5. No element has `role: "math"` with empty children (would indicate KaTeX hadn't hydrated when the snapshot was taken — increase the wait).

If any of those are wrong, fix the source before checking in the snapshot.

## Task 5: Layer 3 — virtual screen reader walking equations

**Files:** `viewer/tests/a11y/equation-reading.spec.ts` (new), `viewer/tests/a11y/setup-virtual-sr.ts` (new helper)

- [ ] **Step 1: Write the virtual-SR setup helper**

`viewer/tests/a11y/setup-virtual-sr.ts`:

```ts
import path from "node:path";
import fs from "node:fs/promises";
import type { Page } from "@playwright/test";

let scriptCache: string | null = null;

async function loadVirtualReaderScript(): Promise<string> {
  if (scriptCache) return scriptCache;
  const file = path.join(
    process.cwd(),
    "node_modules/@guidepup/virtual-screen-reader/lib/index.global.js"
  );
  scriptCache = await fs.readFile(file, "utf8");
  return scriptCache;
}

export async function attachVirtualReader(page: Page): Promise<void> {
  const script = await loadVirtualReaderScript();
  await page.addInitScript(script);
}
```

If `@guidepup/virtual-screen-reader` does not ship an IIFE bundle at that exact path, replace the path with the actual bundle (`ls node_modules/@guidepup/virtual-screen-reader/lib/`) — the package ships an ESM build and a UMD build; use whichever resolves to a global `virtual` object when injected.

- [ ] **Step 2: Write the equation-reading spec**

`viewer/tests/a11y/equation-reading.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { attachVirtualReader } from "./setup-virtual-sr";

declare global {
  interface Window {
    virtual: {
      start: (opts: { container: Element }) => Promise<void>;
      next: () => Promise<void>;
      previous: () => Promise<void>;
      stop: () => Promise<void>;
      spokenPhraseLog: () => Promise<string[]>;
      lastSpokenPhrase: () => Promise<string>;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await attachVirtualReader(page);
});

test("a rendered display equation is announced as math, not as raw LaTeX", async ({ page }) => {
  await page.goto("/");
  // The TabbedProof Equations panel renders a known DisplayLatex equation.
  await page.getByRole("tab", { name: /Equations/i }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".katex-mathml math").length > 0
  );

  const spoken = await page.evaluate(async () => {
    const math = document.querySelector(".katex-mathml math")!;
    await window.virtual.start({ container: math });
    const phrases: string[] = [];
    for (let i = 0; i < 12; i++) {
      await window.virtual.next();
      phrases.push(await window.virtual.lastSpokenPhrase());
    }
    await window.virtual.stop();
    return phrases;
  });

  // The Feynman equation is r-dot cross r-dot + r cross F/m = 0. We don't
  // pin the exact prose (varies by reader model) — only that the math
  // structure is reflected in the spoken stream.
  const joined = spoken.join(" ").toLowerCase();
  expect(joined).toMatch(/equation|math/);
  expect(joined).toMatch(/equal|equals/);
  // Negative assertion: the literal LaTeX command names must not leak.
  expect(joined).not.toMatch(/backslash|ddot|vec|frac/);
});

test("playing the demo does not stack two live-region announcements", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => !!document.querySelector('[role="tabpanel"] iframe, [role="tabpanel"] video')
  );

  // Count visible aria-live regions inside the demo. The standard-captions
  // pane was switched to aria-live="off" — only the transcript should remain.
  const liveRegions = await page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]')!;
    return Array.from(panel.querySelectorAll('[aria-live]'))
      .map((el) => ({
        live: el.getAttribute("aria-live"),
        role: el.getAttribute("role"),
      }));
  });

  const announcing = liveRegions.filter((r) => r.live === "polite" || r.live === "assertive");
  expect(announcing.length).toBe(1);
  expect(announcing[0].role).toBe("status");
});
```

- [ ] **Step 3: Run it**

```sh
cd viewer && npx playwright test equation-reading.spec.ts
```

The first test verifies the marketing claim ("MathML output · MathCAT · VoiceOver") at the lowest level we can in CI. The second test enforces the dual-live-region fix structurally — if anyone re-adds `aria-live="polite"` to `AutoCaptionPanel`, this test fails.

## Task 6: Wire scripts and remove the old test file

**Files:** `viewer/package.json`, `viewer/lib/accessibility-contract.test.ts` (delete)

- [ ] **Step 1: Delete the source-grep test file**

```sh
rm viewer/lib/accessibility-contract.test.ts
```

The new layers cover every claim that file was checking:

| Old contract test | Replaced by |
|---|---|
| `href="#main-content"` present | axe `bypass` rule + AT-tree snapshot showing the skip link |
| CTA arrows aria-hidden | axe rule `decorative-content` + AT-tree snapshot (arrows don't appear in tree) |
| Hero badge says "MathML output" not "MathML native" | leave as a 1-line assertion inside `landing.axe.spec.ts` if you want regression coverage on the copy specifically — otherwise let manual review catch wording |
| Tab semantics | AT-tree snapshot shows tablist with five tabs |
| Single live region in demo | `equation-reading.spec.ts` test 2 |
| Inactive captions don't use opacity | axe `color-contrast` rule (computed value) |
| `prefers-reduced-motion` honored in CSS | leave as a 2-line CSS file check OR drop — the failure mode is non-blocking and not worth a custom test |
| YouTube iframe gets title + cc_load_policy | AT-tree snapshot shows iframe with non-empty title; axe `frame-title` rule |

If you want a thin replacement for the copy-only assertions, add a single test to `landing.axe.spec.ts`:

```ts
test("hero badge copy is honest about MathML support", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("MathML output")).toBeVisible();
  await expect(page.getByText("MathML native")).toHaveCount(0);
});
```

- [ ] **Step 2: Update `viewer/package.json` scripts**

Replace the `scripts` block:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "node --import tsx --test \"lib/**/*.test.ts\"",
  "test:a11y": "playwright test",
  "test:all": "npm run test && npm run test:a11y"
}
```

- [ ] **Step 3: Verify everything still runs**

```sh
cd viewer
npm test          # node:test — should still be 67 tests (one less than 68; we deleted accessibility-contract)
npm run test:a11y # Playwright — 6 tests across 3 spec files, all green
npm run test:all  # both
```

If `npm test` reports anything other than 67/67, investigate before moving on.

## Task 7: Document for future contributors

**Files:** `viewer/tests/a11y/README.md` (new)

- [ ] **Step 1: Write a short README at `viewer/tests/a11y/README.md`**

```markdown
# Accessibility tests

Three layers, all gated on `npm run test:a11y`:

1. **`landing.axe.spec.ts`** — runs axe-core against the rendered landing page
   in initial and post-interaction states. Catches WCAG rule violations.
2. **`landing.tree.spec.ts`** — pins the Chrome accessibility tree shape.
   Catches structural drift. Update snapshots with
   `npx playwright test --update-snapshots`.
3. **`equation-reading.spec.ts`** — drives `@guidepup/virtual-screen-reader`
   against the live DOM. Verifies equations are read as math, not LaTeX,
   and that the demo viewer doesn't stack two live-region announcements.

## Not covered here (and why)

- **Real NVDA/JAWS/VoiceOver behavior.** The virtual screen reader is a model.
  It catches the announce-order class of bugs but cannot catch e.g. an
  NVDA-Browse-Mode-only regression, an MathCAT addon version issue, or a
  JAWS-on-Edge quirk. The plan for that gap is a quarterly Fable session
  (https://www.makeitfable.com) before each minor release.
- **Forms / dashboard / login.** Out of scope until those surfaces are
  re-audited. Add `dashboard.axe.spec.ts` etc. following the same pattern.

## When a test fails

- **Axe violation:** fix the source. Don't silence rules.
- **Tree snapshot diff:** read the diff. If the change is intentional and
  the new shape is correct, run `--update-snapshots` and commit. If the
  change is unintentional, fix the source.
- **Virtual SR test:** investigate before silencing. The most common cause
  is a KaTeX hydration race — wait longer in the test before reading the
  DOM rather than weakening the assertion.
```

---

## Verification checklist

After all tasks complete, in order:

- [ ] `cd viewer && npm test` reports 67/67 passing (was 68/68; we removed one file).
- [ ] `cd viewer && npm run test:a11y` reports 6/6 passing across the three new spec files.
- [ ] `cd viewer && npm run lint` reports no new errors introduced by the new test files.
- [ ] `cd viewer && npx tsc --noEmit` reports no type errors.
- [ ] `git status` shows: deleted `viewer/lib/accessibility-contract.test.ts`; new `viewer/playwright.config.ts`, `viewer/tests/a11y/*.ts`, `viewer/tests/a11y/__snapshots__/*.json`, `viewer/tests/a11y/README.md`; modified `viewer/package.json`, `viewer/package-lock.json`, `viewer/.gitignore`, `viewer/eslint.config.mjs`.
- [ ] Snapshot files are <50 lines each (if they're huge, `interestingOnly: true` isn't being honored — debug before committing).
- [ ] Commit message references this plan: `Layer accessibility testing per docs/design-history/plans/2026-06-26-a11y-testing-layers.md`.

## Stop conditions — escalate, don't paper over

- If `@guidepup/virtual-screen-reader` does not provide a usable global injection path, stop and ask. Do NOT bypass by writing a fake virtual reader inline; the whole point is realism.
- If axe reports >5 violations on the initial landing page, stop and ask. That signals the audit missed something larger and we want a human in the loop on prioritization, not 5 silent allowlist entries.
- If snapshots come out >500 lines, stop. Either the `interestingOnly` filter isn't applying or there's a tree-shape problem worth diagnosing.
- If the demo viewer test in Task 5 finds zero live regions (instead of exactly one), stop. That means the `SegmentList` aria-live got dropped somewhere between this plan and execution, and we have a regression to address before the test even helps.
