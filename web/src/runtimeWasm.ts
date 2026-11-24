/**
 * The asyncify ORT builds are over the 25 MiB per-file limit of Cloudflare static assets,
 * so production loads them from jsDelivr at the exact installed version. jsDelivr sends
 * CORS and `Cross-Origin-Resource-Policy: cross-origin`, which a COEP page needs.
 * `public/.assetsignore` keeps the local copies out of the deploy.
 */
export function asyncifyWasmUrl(ortVersion: string, localUrl: string): string {
  return import.meta.env.PROD
    ? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/ort-wasm-simd-threaded.asyncify.wasm`
    : localUrl;
}
