import type { AsrBackend } from "../asr/models";
import type { PairId } from "../core/pair";
import type { CapabilityIssue } from "../models";
import { en } from "./i18n.en";
import { ja } from "./i18n.ja";
import { targetLang } from "./pairLang";

export type Locale = "en" | "ja";

/** Text with bold runs, for copy that points at words in a browser dialog. */
export type RichText = readonly (string | { readonly strong: string })[];

type Kind3 = "mic" | "tab" | "file";
type ByPair<T> = Readonly<Record<PairId, T>>;
type ByKind<T> = Readonly<Record<Kind3, T>>;

/**
 * Every user-visible string in `src/ui`, nested by area. Parameterized strings are functions so each
 * language can order the words its own way. Both catalogs are typed as `Messages`, so a missing key fails
 * the type check.
 */
export interface Messages {
  readonly locale: Locale;
  readonly documentTitle: string;
  /** The name of each language, in this UI's language. `ja` and `en` are the speech languages of a pair. */
  readonly language: Readonly<Record<"ja" | "en", string>>;
  readonly units: { readonly seconds: string; readonly milliseconds: string };
  readonly app: { readonly sidebarLabel: string };
  readonly header: { readonly themeToLight: string; readonly themeToDark: string };
  readonly pair: {
    readonly triggerLabel: (current: string) => string;
    readonly menuLabel: string;
    readonly options: ByPair<{ readonly title: string; readonly hint: string }>;
    readonly disabledLive: string;
    readonly disabledBusy: string;
  };
  readonly status: {
    readonly checking: string;
    readonly setupNeeded: string;
    readonly downloading: (percent: number) => string;
    readonly loadingModels: string;
    readonly ready: string;
    readonly starting: string;
    readonly live: string;
    readonly finishing: string;
    readonly needsAttention: string;
  };
  readonly health: { readonly behind: (seconds: number) => string; readonly overloaded: (seconds: number) => string };
  readonly setup: {
    readonly title: string;
    readonly checking: string;
    readonly ledeError: string;
    readonly ledeLoading: string;
    readonly ledeSetup: (size: string) => string;
    readonly browserHeading: string;
    readonly webgpuOk: (gpuLabel: string | null) => string;
    /** The line for a capability problem; English keeps the check's own wording. */
    readonly issue: (issue: CapabilityIssue) => string;
    readonly issuesNote: string;
    readonly speechHeading: string;
    readonly speechModel: ByPair<string>;
    readonly backend: Readonly<Record<AsrBackend, { readonly title: string; readonly detail: string }>>;
    readonly recommended: string;
    readonly sizeTotal: (size: string) => string;
    readonly overrode: (recommended: string) => string;
    readonly notIsolated: string;
    readonly gpuProblems: string;
    readonly modelsHeading: string;
    readonly noModels: string;
    readonly overall: (done: string, total: string) => string;
    readonly progressLabel: string;
    readonly pause: string;
    readonly downloading: string;
    readonly loadModels: string;
    readonly resume: (left: string) => string;
    readonly download: (total: string) => string;
    readonly retry: (left: string, partial: boolean) => string;
    readonly file: {
      readonly verifying: string;
      readonly failed: string;
      readonly partial: (done: string, total: string) => string;
      readonly verified: (size: string) => string;
    };
    readonly enginesHeading: string;
    readonly phases: { readonly vad: string; readonly asr: string; readonly mt: string };
    readonly phaseLoading: string;
    readonly phaseWaiting: string;
    readonly loadingFor: (time: string) => string;
    readonly fatalHeading: string;
    readonly tryAgain: string;
    readonly endpoint: {
      readonly standard: (host: string) => string;
      readonly custom: (url: string) => string;
      readonly invalid: (raw: string, host: string) => string;
    };
  };
  readonly errors: {
    readonly unknown: string;
    readonly bootCheck: (reason: string) => string;
    readonly storageRead: (reason: string) => string;
    readonly downloadIncomplete: string;
    readonly modelsLoad: (reason: string) => string;
    readonly tabCancelled: string;
    readonly micBlocked: string;
    readonly micMissing: string;
    readonly micBusy: string;
    readonly captureAborted: string;
    readonly noTabAudio: string;
    readonly wavEmpty: (name: string) => string;
    readonly wavNoAudio: (name: string) => string;
    readonly wavUnreadable: (name: string, reason: string) => string;
    readonly wavTooLarge: (name: string) => string;
    readonly pipUnsupported: string;
    readonly pipInsecure: string;
    readonly pipNeedsClick: string;
    readonly pipOpenFailed: (reason: string | null) => string;
  };
  readonly source: {
    readonly legend: string;
    readonly label: ByKind<string>;
    readonly hint: ByKind<string>;
    readonly fileHint: (name: string, size: string, kilohertz: number) => string;
    readonly chooseWav: string;
    readonly chooseAnother: string;
    readonly dropHint: string;
  };
  readonly live: {
    readonly title: string;
    readonly floatingOpen: string;
    readonly floatingClose: string;
    readonly floatingOpening: string;
    readonly sourceRunning: (label: string, elapsed: string) => string;
    readonly readyTitle: string;
    readonly emptyCopy: ByPair<ByKind<string>>;
    readonly modelsLoadedIn: (time: string) => string;
    readonly waitingTitle: string;
    readonly waitingBody: ByKind<string>;
    readonly listeningTitle: string;
    readonly listeningBody: string;
    readonly finishingTitle: string;
    readonly finishingBody: string;
    readonly start: string;
    readonly stop: string;
    readonly starting: string;
    readonly finishing: string;
    readonly shareGuide: {
      readonly title: string;
      readonly intro: string;
      readonly steps: readonly RichText[];
      readonly cancel: string;
      readonly continue: string;
    };
  };
  readonly transcript: {
    readonly logLabel: string;
    readonly translating: string;
    readonly unavailable: string;
    readonly liveTag: string;
    readonly retranslating: string;
    readonly revised: (times: number) => string;
    readonly revisedTitle: string;
    readonly timingDetail: string;
    /** The first timing row: where the translation came from, named by its language. */
    readonly from: (targetLanguage: string) => string;
    readonly vadWait: string;
    readonly queueWait: string;
    readonly asr: string;
    readonly mt: string;
    readonly perceived: string;
    readonly endToEnd: string;
    readonly jump: string;
    readonly jumpNew: (count: number) => string;
    readonly pipelineError: (reason: string) => string;
  };
  readonly pip: { readonly empty: string; readonly windowTitle: string };
  readonly glossary: {
    readonly heading: string;
    readonly help: ByPair<string>;
    readonly empty: string;
    readonly columns: ByPair<{ readonly source: string; readonly target: string }>;
    readonly fields: ByPair<{
      readonly sourcePlaceholder: string;
      readonly sourceLabel: string;
      readonly targetPlaceholder: string;
      readonly targetLabel: string;
      readonly entrySource: (n: number) => string;
      readonly entryTarget: (n: number) => string;
    }>;
    readonly add: string;
    readonly remove: (source: string) => string;
    readonly unsaved: string;
    readonly kind: ByPair<Readonly<Record<"term" | "asr-fix", { readonly label: string; readonly hint: string }>>>;
    readonly idleHint: ByPair<string>;
    readonly errors: {
      readonly emptySource: ByPair<string>;
      readonly emptyTarget: string;
      readonly duplicateSource: string;
      readonly tooLong: (max: number) => string;
      readonly full: (max: number) => string;
    };
  };
  readonly diagnostics: {
    readonly summary: string;
    readonly webgpu: string;
    readonly runtime: string;
    readonly loadTimes: string;
    readonly latency: string;
    readonly checkingGpu: string;
    readonly gpuUnavailable: (reason: string) => string;
    readonly gpuAdapter: (name: string) => string;
    readonly fields: {
      readonly crossOriginIsolated: string;
      readonly asrBackend: string;
      readonly asrDevice: string;
      readonly mtRuntime: string;
      readonly mtAdapter: string;
      readonly storage: string;
      readonly endpoint: string;
      readonly theme: string;
      readonly total: string;
      readonly lines: string;
      readonly p50: string;
      readonly p95: string;
    };
    readonly chosen: string;
    readonly defaultEndpoint: string;
    readonly fallback: string;
    readonly singleThread: string;
    readonly cores: (count: number) => string;
    readonly theme: { readonly system: (effective: string) => string; readonly light: string; readonly dark: string };
  };
}

export const catalogs: Readonly<Record<Locale, Messages>> = { en, ja };

export function messagesFor(locale: Locale): Messages {
  return catalogs[locale];
}

/**
 * `?lang=en|ja` wins, so a page can be pinned either way. Otherwise the UI speaks the captions' language:
 * whoever reads Japanese captions reads Japanese.
 */
export function pickLocale(pair: PairId, search: string): Locale {
  const forced = new URLSearchParams(search).get("lang");
  if (forced === "en" || forced === "ja") return forced;
  return targetLang(pair);
}
