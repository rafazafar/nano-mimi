import type { Manifest } from "./types";

/**
 * The shipped model list. Empty until the runtime spikes pick the final ONNX files and
 * their hashes are known; add entries here (see `ModelSpec`) rather than changing the store.
 * The setup page can also load a manifest from `?manifest=<url>` for testing.
 */
export const DEFAULT_MANIFEST: Manifest = { models: [] };
