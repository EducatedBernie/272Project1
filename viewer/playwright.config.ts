import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/a11y",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Serial: the tests share one dev server and assert on a playing demo video,
  // so parallel workers make them timing-dependent.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001",
    trace: "retain-on-failure",
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{arg}{ext}",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3001",
    url: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
