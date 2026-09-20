import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
    testDir: join(__dirname, "..", "test"),
    testMatch: "artifact-runtime.spec.ts",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: "list",
    use: {
        baseURL: "http://localhost:4174",
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
        },
        {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
        },
    ],
    webServer: {
        command: "npx vite preview --config apps/web/vite.config.ts --port 4174 --host",
        url: "http://localhost:4174/artifact-renderer.html",
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        cwd: "C:/codebases/Moneo",
    },
});