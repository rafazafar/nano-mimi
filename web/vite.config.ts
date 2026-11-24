import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pre-bundle at startup: discovering it when the MT worker first loads makes Vite reload the page.
  optimizeDeps: { include: ["@huggingface/transformers"] },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: { main: "index.html", setup: "setup.html", vad: "vad.html" },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
