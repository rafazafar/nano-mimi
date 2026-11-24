import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: "index.html", vad: "vad.html" },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
