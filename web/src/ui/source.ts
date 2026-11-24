import { decodeWav } from "../audio/wav";
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

export const SOURCE_LABEL: Readonly<Record<SourceKind, string>> = { mic: "Microphone", tab: "Browser tab", file: "WAV file" };

export function parseWavPick(name: string, bytes: Uint8Array): PickResult {
  if (bytes.length === 0) return { ok: false, message: `${name} is empty.` };
  if (bytes.length > MAX_WAV_BYTES) return tooLarge(name);
  try {
    const head = decodeWav(bytes.subarray(0, HEADER_BYTES));
    if (head.samples.length === 0) return { ok: false, message: `${name} contains no audio.` };
    return { ok: true, pick: { name, bytes, sampleRate: head.sampleRate } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${name} is not a WAV this app can replay (${reason}). Use 16-bit PCM or 32-bit float WAV.` };
  }
}

export async function readWavPick(file: File): Promise<PickResult> {
  if (file.size > MAX_WAV_BYTES) return tooLarge(file.name);
  return parseWavPick(file.name, new Uint8Array(await file.arrayBuffer()));
}

function tooLarge(name: string): PickResult {
  return { ok: false, message: `${name} is larger than 1 GB, which is more than the browser can replay.` };
}
