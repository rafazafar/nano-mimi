import { defineConfig } from "vitest/config";

/** Threaded wasm (the ASR fallback and Silero) needs SharedArrayBuffer, which needs a cross-origin-isolated page. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
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
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
