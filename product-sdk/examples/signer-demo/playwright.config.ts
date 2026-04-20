import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
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
        command: "pnpm vite --port 5210",
        port: 5210,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
