import "../../src/ui/styles/index.css";
import { performanceClock } from "../../src/pipeline";
import { mountApp, type AppHandle } from "../../src/ui/app";
import type { AppDeps } from "../../src/ui/deps";
import type { DocumentPipApi } from "../../src/ui/pip";
import { browserStorage } from "../../src/ui/storage";
import { DownloadControl, EnginesControl, FakeDisk, FakeStore, SessionControl, type FakePipWindows } from "./fakes";
import { fakeGpu, fakeIssues, parseScenario } from "./scenario";

/** What a Playwright test drives. Everything the app reaches outside the DOM is a scripted stand-in here. */
export interface Harness {
  readonly app: AppHandle;
  readonly download: DownloadControl;
  readonly engines: EnginesControl;
  readonly session: SessionControl;
  readonly pip: FakePipWindows;
  readonly state: () => string;
}

declare global {
  interface Window {
    __harness?: Harness;
  }
}

const scenario = parseScenario(location.search);
const disk = new FakeDisk(scenario.stored);
const download = new DownloadControl();
const engines = new EnginesControl(scenario.engines === "auto");
const session = new SessionControl();
const pip: FakePipWindows = { windows: [], denyNext: false };

/** Opens a real popup so the floating window has its own document, timers and `pagehide`. */
const fakePipApi: DocumentPipApi = {
  async requestWindow(options) {
    if (pip.denyNext) {
      pip.denyNext = false;
      throw new DOMException("Needs a user gesture", "NotAllowedError");
    }
    const popup = window.open("about:blank", "_blank", `popup,width=${options?.width ?? 460},height=${options?.height ?? 320}`);
    if (popup === null) throw new DOMException("The popup was blocked", "NotAllowedError");
    pip.windows.push(popup);
    return popup;
  },
  get window() {
    return pip.windows.at(-1) ?? null;
  },
};

const pipApi = (): DocumentPipApi | undefined => {
  switch (scenario.pip) {
    case "fake":
      return fakePipApi;
    case "real":
      return (window as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
    case "none":
      return undefined;
  }
};

const deps: AppDeps = {
  probeGpu: async () => fakeGpu(scenario.gpu),
  checkCapabilities: async () => fakeIssues(scenario.gpu),
  createModelStore: (manifest, onState) => new FakeStore(manifest, disk, onState, download),
  loadEngines: (_manifest, _backend, pair, onPhase) => engines.load(pair, onPhase),
  startSession: (options) => session.start(options),
  storage: browserStorage(),
  clock: performanceClock,
  env: {
    search: location.search,
    crossOriginIsolated,
    // `?builtin` stands in for a Chrome with on-device speech and translation.
    builtInAi: new URLSearchParams(location.search).has("builtin"),
    systemDark: matchMedia("(prefers-color-scheme: dark)"),
    pip: pipApi(),
    secureContext: isSecureContext,
    // `?lang=ja-JP` stands in for a Japanese browser.
    languages: new URLSearchParams(location.search).get("lang")?.split(",") ?? ["en-US"],
    canCaptureTab: new URLSearchParams(location.search).has("tab"),
  },
};

const root = document.getElementById("app");
if (root === null) throw new Error("#app missing from the harness page");
const app = mountApp(root, deps);
window.__harness = { app, download, engines, session, pip, state: () => app.state().kind };
