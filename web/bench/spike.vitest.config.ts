import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["bench/**/*.spike.test.ts"] } });
