import { probeGpu } from "../gpu";
import { OpfsBlobStore, ModelStore, checkCapabilities } from "../models";
import { loadEngines, performanceClock, startSession } from "../pipeline";
import type { AppDeps } from "./deps";
import { browserStorage } from "./storage";

/** The browser, the W3 model store on OPFS and the live pipeline. The only place the app meets them. */
export function realDeps(): AppDeps {
  return {
    probeGpu: () => probeGpu(navigator.gpu),
    checkCapabilities: (req) => checkCapabilities(navigator.gpu, req),
    createModelStore: (manifest, onState) =>
      new ModelStore({ manifest, store: new OpfsBlobStore(), storage: navigator.storage, onState }),
    loadEngines,
    startSession,
    storage: browserStorage(),
    clock: performanceClock,
    env: {
      search: location.search,
      crossOriginIsolated,
      systemDark: matchMedia("(prefers-color-scheme: dark)"),
      pip: (window as { documentPictureInPicture?: AppDeps["env"]["pip"] }).documentPictureInPicture,
      secureContext: isSecureContext,
    },
  };
}
