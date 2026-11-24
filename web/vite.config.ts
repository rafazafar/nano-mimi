import { defineConfig } from "vitest/config";

export default defineConfig({
  build: { rollupOptions: { input: ["index.html", "setup.html"] } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
