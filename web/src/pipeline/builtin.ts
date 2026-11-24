import type { PairId } from "../core/pair";
import { asEnText, asJaText, type JaText } from "../core/types";
import type { Translation } from "../mt/client";
import type { MtOutcome } from "../mt/protocol";
import type { MtEngine } from "./types";

// Chrome's on-device Translator API and SpeechRecognition with `processLocally` are not in lib.dom yet.
type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface ChromeTranslator {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}

interface RecognitionAlternative {
  readonly transcript: string;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: RecognitionAlternative;
}

interface RecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}

interface RecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
}

interface RecognizerFactory {
  new (): Recognizer;
  available(options: { langs: string[]; processLocally: boolean }): Promise<Availability>;
  install(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

const api = globalThis as { Translator?: TranslatorFactory; SpeechRecognition?: Partial<RecognizerFactory> };

/** Chrome downloads, shares and updates these packs itself; this app ships none of it. */
const LANGS: Readonly<Record<PairId, { readonly speech: string; readonly source: string; readonly target: string }>> = {
  "ja-en": { speech: "ja-JP", source: "ja", target: "en" },
  "en-ja": { speech: "en-US", source: "en", target: "ja" },
};

/** True where the browser can recognize speech and translate on the device without any model of ours. */
export function builtInSupported(): boolean {
  return api.Translator !== undefined && typeof api.SpeechRecognition?.available === "function" && typeof api.SpeechRecognition.install === "function";
}

export class NeedsClickError extends Error {
  constructor(what: "speech" | "translation") {
    super(`Chrome needs one more click to set up its ${what} pack for this site. Press Try again.`);
  }
}

/**
 * Chrome reports a pack as downloadable to each new site, even when another site already installed it, and
 * every install needs its own click. Each call that needs one throws `NeedsClickError` without a click.
 */
function requireClick(what: "speech" | "translation"): void {
  if (!navigator.userActivation.isActive) throw new NeedsClickError(what);
}

export async function prepareSpeech(pair: PairId): Promise<string> {
  const factory = api.SpeechRecognition as RecognizerFactory;
  const langs = [LANGS[pair].speech];
  const availability = await factory.available({ langs, processLocally: true });
  if (availability === "unavailable") throw new Error(`Chrome cannot recognize ${langs[0]} speech on this device.`);
  if (availability !== "available") {
    requireClick("speech");
    if (!(await factory.install({ langs, processLocally: true }))) throw new Error(`Chrome could not install its ${langs[0]} speech pack.`);
  }
  return langs[0]!;
}

export async function prepareTranslator(pair: PairId): Promise<BrowserTranslator> {
  const factory = api.Translator!;
  const options = { sourceLanguage: LANGS[pair].source, targetLanguage: LANGS[pair].target };
  const availability = await factory.availability(options);
  if (availability === "unavailable") throw new Error(`Chrome cannot translate ${options.sourceLanguage} to ${options.targetLanguage} on this device.`);
  if (availability !== "available") requireClick("translation");
  return new BrowserTranslator(await factory.create(options));
}

/** Chrome's Translator as the pipeline's MT engine. It does not stream, so `onToken` is never called. */
export class BrowserTranslator implements MtEngine {
  constructor(private readonly translator: ChromeTranslator) {}

  translate(ja: JaText): Translation {
    const abort = new AbortController();
    const t0 = performance.now();
    const outcome = this.translator.translate(ja, { signal: abort.signal }).then(
      (en): MtOutcome => ({
        kind: "done",
        result: { en: asEnText(en), raw: en, promptLeak: false, japaneseStripped: false, numbersMismatch: false, attempts: [], kept: 0, totalMs: performance.now() - t0 },
      }),
      (error: unknown): MtOutcome => {
        if (abort.signal.aborted) return { kind: "cancelled" };
        throw error;
      },
    );
    return { outcome, cancel: () => abort.abort() };
  }

  destroy(): void {
    this.translator.destroy();
  }
}

export interface RecognitionHandlers {
  /** The utterance in flight so far. */
  onPartial(text: JaText): void;
  onFinal(text: JaText): void;
  onError(detail: string): void;
}

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "gu");

/** Chrome's Japanese recognizer separates words with spaces ("国連 で は"); Japanese text has none. */
export function joinJapanese(text: string): string {
  return text.replace(CJK_GAP, "");
}

/** Errors that only mean "nothing was said"; recognition restarts after them. */
const QUIET_ERRORS = new Set(["no-speech", "aborted"]);

/**
 * Runs Chrome's on-device recognizer over `track` until `stop()`. Chrome ends a continuous session on its own
 * after silence or an error, so it is restarted on the same track until stopped.
 */
export function startRecognition(track: MediaStreamTrack, lang: string, handlers: RecognitionHandlers): { stop(): Promise<void> } {
  const Factory = api.SpeechRecognition as RecognizerFactory;
  const tidy = lang.startsWith("ja") ? joinJapanese : (text: string) => text;
  let stopped = false;
  // A real error would only repeat, so the recognizer is not restarted after one.
  let failed = false;
  let current: Recognizer;
  let ended: Promise<void>;

  const run = (): void => {
    const rec = new Factory();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = true;
    const emitted = new Set<number>();
    rec.onresult = (event) => {
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (!result.isFinal) partial += tidy(result[0].transcript);
        else if (!emitted.has(i)) {
          emitted.add(i);
          handlers.onFinal(asJaText(tidy(result[0].transcript)));
        }
      }
      if (partial !== "") handlers.onPartial(asJaText(partial));
    };
    rec.onerror = (event) => {
      if (QUIET_ERRORS.has(event.error)) return;
      failed = true;
      handlers.onError(`Speech recognition failed: ${event.error}${event.message ? ` (${event.message})` : ""}`);
    };
    ended = new Promise((resolve) => {
      rec.onend = () => {
        resolve();
        if (!stopped && !failed && track.readyState === "live") run();
      };
    });
    current = rec;
    rec.start(track);
  };
  run();

  return {
    async stop() {
      stopped = true;
      current.stop();
      // stop() flushes the last final; give it a moment to arrive.
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 1500))]);
    },
  };
}
