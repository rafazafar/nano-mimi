import { decodeWav } from "../audio/wav";
import type { Messages } from "./i18n";
import type { SourceSpec } from "../pipeline";

export type SourceKind = "mic" | "tab" | "file";

/** A WAV the user picked, already checked to be one the session can decode. */
export interface PickedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sampleRate: number;
}

/** What the picker currently selects. A file choice has no audio until the user supplies one. */
export type SourceChoice =
  | { readonly kind: "mic" }
  | { readonly kind: "tab" }
  | { readonly kind: "file"; readonly pick: PickedFile | null };

export type PickResult =
  | { readonly ok: true; readonly pick: PickedFile }
  | { readonly ok: false; readonly message: string };

export const MAX_WAV_BYTES = 1024 * 1024 * 1024;
const HEADER_BYTES = 1024 * 1024;

export function toSourceSpec(choice: SourceChoice): SourceSpec | null {
  if (choice.kind === "file") return choice.pick === null ? null : { kind: "file", name: choice.pick.name, bytes: choice.pick.bytes };
  return { kind: choice.kind };
}

export function parseWavPick(name: string, bytes: Uint8Array, m: Messages): PickResult {
  if (bytes.length === 0) return { ok: false, message: m.errors.wavEmpty(name) };
  if (bytes.length > MAX_WAV_BYTES) return tooLarge(name, m);
  try {
    const head = decodeWav(bytes.subarray(0, HEADER_BYTES));
    if (head.samples.length === 0) return { ok: false, message: m.errors.wavNoAudio(name) };
    return { ok: true, pick: { name, bytes, sampleRate: head.sampleRate } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: m.errors.wavUnreadable(name, reason) };
  }
}

export async function readWavPick(file: File, m: Messages): Promise<PickResult> {
  if (file.size > MAX_WAV_BYTES) return tooLarge(file.name, m);
  return parseWavPick(file.name, new Uint8Array(await file.arrayBuffer()), m);
}

function tooLarge(name: string, m: Messages): PickResult {
  return { ok: false, message: m.errors.wavTooLarge(name) };
}
