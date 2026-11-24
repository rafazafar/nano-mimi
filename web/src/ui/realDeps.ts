import { probeGpu } from "../gpu";
import { OpfsBlobStore, ModelStore, checkCapabilities } from "../models";
import { loadEngines, performanceClock, startSession } from "../pipeline";
import { builtInSupported } from "../pipeline/builtin";
import type { AppDeps } from "./deps";
import { browserStorage } from "./storage";

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
      builtInAi: builtInSupported(),
      systemDark: matchMedia("(prefers-color-scheme: dark)"),
      pip: (window as { documentPictureInPicture?: AppDeps["env"]["pip"] }).documentPictureInPicture,
      secureContext: isSecureContext,
      languages: navigator.languages,
      canCaptureTab: typeof navigator.mediaDevices?.getDisplayMedia === "function",
    },
  };
}
