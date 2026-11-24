import type { PairId } from "../../src/core/pair";
import type { Glossary } from "../../src/core/glossary";
import { asJaText } from "../../src/core/types";
import type { StorageGrant } from "../../src/models";
import { StorageQuotaError, type FileRef, type FileState, type Manifest } from "../../src/models/types";
import type { EnginePhase, Engines, EngineInfo, PipelineEvent, Session, SessionOptions, SourceSpec } from "../../src/pipeline";
import type { ModelStoreLike } from "../../src/ui/deps";
import { fileKey } from "../../src/ui/setupModel";
import type { StoredFiles } from "./scenario";

/** What is "on disk": shared by every store the app builds, so a backend switch or retry sees the same files. */
export class FakeDisk {
  private readonly files = new Map<string, FileState>();

  constructor(private readonly stored: StoredFiles) {}

  state(manifest: Manifest, ref: FileRef): FileState {
    const known = this.files.get(fileKey(ref));
    if (known !== undefined) return known;
    if (this.stored === "all") return { kind: "ready" };
    if (this.stored === "partial") {
      const all = manifest.models.flatMap((model) => model.files.map((file) => ({ modelId: model.id, path: file.path })));
      const index = all.findIndex((candidate) => candidate.modelId === ref.modelId && candidate.path === ref.path);
      return index >= 0 && index < Math.floor(all.length / 2) ? { kind: "ready" } : { kind: "missing" };
    }
    return { kind: "missing" };
  }

  set(ref: FileRef, state: FileState): void {
    this.files.set(fileKey(ref), state);
  }
}

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** A model store whose download only moves when the test says so. */
export class FakeStore implements ModelStoreLike {
  readonly storageGrant: StorageGrant = "persistent";
  private pending: Pending | null = null;
  private refs: FileRef[] = [];
  private sizes = new Map<string, number>();

  constructor(
    private readonly manifest: Manifest,
    private readonly disk: FakeDisk,
    private readonly onState: (ref: FileRef, state: FileState) => void,
    private readonly control: DownloadControl,
  ) {
    for (const model of manifest.models) {
      for (const file of model.files) {
        const ref = { modelId: model.id, path: file.path };
        this.refs.push(ref);
        this.sizes.set(fileKey(ref), file.size);
      }
    }
    control.attach(this);
  }

  async refresh(): Promise<void> {
    for (const ref of this.refs) this.onState(ref, this.disk.state(this.manifest, ref));
  }

  allReady(): boolean {
    return this.refs.every((ref) => this.disk.state(this.manifest, ref).kind === "ready");
  }

  ensureAll(signal?: AbortSignal): Promise<void> {
    if (this.control.quota) return Promise.reject(new StorageQuotaError(this.totalMissing(), Math.floor(this.totalMissing() / 3)));
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      signal?.addEventListener(
        "abort",
        () => {
          this.pending = null;
          reject(new DOMException("The download was paused.", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private totalMissing(): number {
    let missing = 0;
    for (const ref of this.refs) if (this.disk.state(this.manifest, ref).kind !== "ready") missing += this.sizes.get(fileKey(ref)) ?? 0;
    return missing;
  }

  /** Puts `fraction` of the bytes still to download on disk, file by file in manifest order. */
  progress(fraction: number): void {
    let budget = this.totalMissing() * fraction;
    for (const ref of this.refs) {
      if (this.disk.state(this.manifest, ref).kind === "ready") continue;
      const size = this.sizes.get(fileKey(ref)) ?? 0;
      const state: FileState = budget >= size ? { kind: "ready" } : budget > 0 ? { kind: "partial", bytes: Math.floor(budget) } : { kind: "missing" };
      budget -= size;
      this.disk.set(ref, state);
      this.onState(ref, state);
    }
  }

  finish(): void {
    for (const ref of this.refs) {
      this.disk.set(ref, { kind: "ready" });
      this.onState(ref, { kind: "ready" });
    }
    this.settle();
  }

  /** Fails the first file that is not ready and lets `ensureAll` return, as the real store does. */
  fail(reason: string): void {
    const ref = this.refs.find((candidate) => this.disk.state(this.manifest, candidate).kind !== "ready");
    if (ref !== undefined) {
      const state: FileState = { kind: "failed", reason };
      this.disk.set(ref, state);
      this.onState(ref, state);
    }
    this.settle();
  }

  private settle(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve();
  }
}

export class DownloadControl {
  quota = false;
  private store: FakeStore | null = null;

  attach(store: FakeStore): void {
    this.store = store;
  }

  progress = (fraction: number): void => this.store?.progress(fraction);
  finish = (): void => this.store?.finish();
  fail = (reason: string): void => this.store?.fail(reason);
  /** The next `ensureAll` throws `StorageQuotaError` before moving any bytes. */
  setQuota = (on: boolean): void => {
    this.quota = on;
  };
}

const ENGINE_INFO: EngineInfo = {
  asr: { backend: "webgpu", crossOriginIsolated: false, hardwareConcurrency: 12, adapter: { vendor: "apple", architecture: "metal-3", isFallbackAdapter: false, shaderF16: true, features: ["shader-f16"] } },
  asrLoadMs: 2400,
  mt: { tokenizerMs: 180, modelMs: 6200, adapter: { vendor: "apple", architecture: "metal-3", description: "Apple M3 Pro", isFallbackAdapter: false, shaderF16: true }, runtime: "transformers.js webgpu" },
  mtLoadMs: 6380,
  vadLoadMs: 310,
  totalLoadMs: 9090,
};

/** The engine loader, stepped by the test (or by a timer in `auto` mode). Returns unusable engines: the UI never calls them. */
export class EnginesControl {
  private onPhase: ((phase: EnginePhase, state: "start" | "done") => void) | null = null;
  private pair: PairId = "ja-en";
  private done: { readonly resolve: (engines: Engines) => void; readonly reject: (error: Error) => void } | null = null;
  disposed = 0;

  constructor(private readonly auto: boolean) {}

  load(pair: PairId, onPhase: (phase: EnginePhase, state: "start" | "done") => void): Promise<Engines> {
    this.pair = pair;
    this.onPhase = onPhase;
    return new Promise<Engines>((resolve, reject) => {
      this.done = { resolve, reject };
      if (this.auto) void this.runAuto();
    });
  }

  private async runAuto(): Promise<void> {
    for (const phase of ["vad", "asr", "mt"] as const) {
      this.phase(phase, "start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      this.phase(phase, "done");
    }
    this.finish();
  }

  phase = (phase: EnginePhase, state: "start" | "done"): void => this.onPhase?.(phase, state);

  finish = (): void => {
    this.done?.resolve(this.engines());
    this.done = null;
  };

  fail = (message: string): void => {
    this.done?.reject(new Error(message));
    this.done = null;
  };

  private engines(): Engines {
    const unused = (what: string) => (): never => {
      throw new Error(`${what} is not used by the UI harness`);
    };
    return {
      pair: this.pair,
      recognition: { kind: "model", asr: { transcribe: async () => asJaText("") }, scorer: { score: async () => 0, reset: () => undefined } },
      mt: { translate: unused("mt.translate") },
      info: ENGINE_INFO,
      dispose: () => {
        this.disposed += 1;
      },
    };
  }
}

/** A capture session the test feeds events into. */
export class SessionControl {
  seconds = 0;
  startedWith: SourceSpec | null = null;
  private emitter: ((event: PipelineEvent) => void) | null = null;
  private glossary: (() => Glossary) | null = null;
  private failure: { readonly name: string; readonly message: string } | null = null;
  private ended: (() => void) | null = null;
  stops = 0;
  starts = 0;

  start(options: SessionOptions): Promise<Session> {
    this.starts += 1;
    if (this.failure !== null) {
      const { name, message } = this.failure;
      this.failure = null;
      return Promise.reject(new DOMException(message, name));
    }
    this.startedWith = options.source;
    this.emitter = options.onEvent;
    this.glossary = options.glossary;
    this.seconds = 0;
    const ended = new Promise<void>((resolve) => {
      this.ended = resolve;
    });
    const label = options.source.kind === "file" ? options.source.name : options.source.kind === "tab" ? "Browser / system audio" : "Microphone";
    return Promise.resolve({
      sourceLabel: label,
      audioSeconds: () => this.seconds,
      stop: async () => {
        this.stops += 1;
      },
      ended: options.source.kind === "file" ? ended : new Promise<void>(() => undefined),
    });
  }

  emit = (...events: readonly PipelineEvent[]): void => {
    for (const event of events) this.emitter?.(event);
  };

  /** A file has played to its end. */
  end = (): void => this.ended?.();

  failNextStart = (name: string, message: string): void => {
    this.failure = { name, message };
  };

  setSeconds = (seconds: number): void => {
    this.seconds = seconds;
  };

  /** What the session would hand the translator right now, as plain pairs. */
  readGlossary = (): [string, string][] => [...(this.glossary?.() ?? [])];
}

export interface FakePipWindows {
  readonly windows: Window[];
  /** The next `requestWindow` is refused as the browser does without a user gesture. */
  denyNext: boolean;
}
