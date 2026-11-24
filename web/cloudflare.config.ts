import { defineConfig } from "cf/config";

// Static site on Workers static assets. `public/_headers` sets the COOP/COEP headers
// that SharedArrayBuffer (threaded wasm) needs.
export default defineConfig({
  worker: {
    name: "mimivox-web",
    compatibilityDate: "2026-11-01",
    domains: ["mimi.zafar.jp"],
    assets: { notFoundHandling: "404-page" },
  },
});
