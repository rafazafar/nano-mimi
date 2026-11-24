import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vitest/config";

const version = (pkg: string): string => JSON.parse(readFileSync(new URL(pkg, import.meta.url), "utf8")).version;

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ command }) => ({
  // Only production builds go through the Cloudflare plugin, which writes the output `cf deploy` uploads.
  plugins: command === "build" ? [cloudflare()] : [],
  define: {
    __ORT_VERSION__: JSON.stringify(version("./node_modules/onnxruntime-web/package.json")),
    __TJS_ORT_VERSION__: JSON.stringify(
      version("./node_modules/@huggingface/transformers/node_modules/onnxruntime-web/package.json"),
    ),
  },
  optimizeDeps: {
    // Pre-bundle at startup: discovering it when the MT worker first loads makes Vite reload the page.
    include: ["@huggingface/transformers"],
    // Pre-bundling ORT on first import reloads the page mid-run and breaks its wasm path resolution.
    exclude: ["onnxruntime-web"],
  },
  worker: { format: "es" },
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
  build: {
    rollupOptions: {
      input: { main: "index.html", setup: "setup.html", vad: "vad.html" },
    },
  },
  test: {
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
    testTimeout: 60_000,
  },
}));
