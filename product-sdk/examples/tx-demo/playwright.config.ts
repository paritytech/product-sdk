import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    workers: 1, // Serial — shared Paseo nonce state, avoid races
    timeout: 120_000, // 2 min per test — chain finalization is slow
    expect: {
        timeout: 30_000,
    },
    retries: process.env.CI ? 1 : 0,
    reporter: [["html", { open: "never" }], ["list"]],

    use: {
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "on-first-retry",
    },

    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],

    webServer: {
        command: "pnpm vite --port 5200",
        port: 5200,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
