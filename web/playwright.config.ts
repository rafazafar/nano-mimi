import { defineConfig } from "@playwright/test";

const PORT = Number(process.env["WEB_E2E_PORT"] ?? 4173);

export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    headless: true,
    launchOptions: { args: ["--enable-unsafe-webgpu"] },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
