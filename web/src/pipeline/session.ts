import type { Glossary } from "../core/glossary";
import type { Engines } from "./engines";
import type { PipelineEvent, PipelineOptions } from "./types";

/** Where the audio comes from. A file is replayed at 1x through the same capture path as the others. */
export type SourceSpec =
  | { readonly kind: "mic" }
  | { readonly kind: "tab" }
  | { readonly kind: "file"; readonly name: string; readonly bytes: Uint8Array };

export interface SessionOptions {
  readonly engines: Engines;
  readonly source: SourceSpec;
  /** Read at every translation, so edits to the glossary apply to the next line. */
  readonly glossary: () => Glossary;
  readonly onEvent: (event: PipelineEvent) => void;
  /** Defaults to the replay policy for a file and the live policy otherwise. */
  readonly pipeline?: PipelineOptions;
}

export interface Session {
  readonly sourceLabel: string;
  /** Seconds of audio the VAD has consumed. */
  audioSeconds(): number;
  /** Stops capture, closes the open utterance, lets queued speech finish, then resolves. */
  stop(): Promise<void>;
  /** Resolves once a file has played to its end and everything queued is on screen. Never for mic or tab. */
  readonly ended: Promise<void>;
}

export function startSession(_options: SessionOptions): Promise<Session> {
  return Promise.reject(new Error("startSession is not implemented yet"));
}
