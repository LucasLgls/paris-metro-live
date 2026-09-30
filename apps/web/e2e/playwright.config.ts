import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_WEB_PORT ?? "5173";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-GB",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ],
  // The production server serves the built web app, the API and the SSE stream from one origin,
  // driven by the offline fixture simulator. `npm run test:e2e` builds the web app first.
  webServer: {
    command: "node --import tsx ../../server/src/cli.ts",
    url: `http://127.0.0.1:${port}/health/live`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      TRANSIT_SOURCE: "fixture",
      HOST: "127.0.0.1",
      PORT: port,
      API_RATE_LIMIT_PER_MINUTE: "5000"
    }
  }
});
