import { describe, expect, it } from "vitest";
import { parseWavPick, toSourceSpec } from "./source";

/** A canonical 44-byte header followed by 16-bit mono PCM. */
function wav(frames: number, opts: { rate?: number; code?: number; bits?: number } = {}): Uint8Array {
  const { rate = 16_000, code = 1, bits = 16 } = opts;
  const dataBytes = frames * (bits / 8);
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string): void => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, code, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * (bits / 8), true);
  view.setUint16(32, bits / 8, true);
  view.setUint16(34, bits, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}

describe("parseWavPick", () => {
  it("accepts a decodable WAV and keeps its bytes and rate", () => {
    const bytes = wav(1600, { rate: 48_000 });
    const result = parseWavPick("meeting.wav", bytes);
    expect(result).toEqual({ ok: true, pick: { name: "meeting.wav", bytes, sampleRate: 48_000 } });
  });

  it("refuses an empty file, a non-WAV and a WAV with no audio, each by name", () => {
    expect(parseWavPick("a.wav", new Uint8Array(0))).toEqual({ ok: false, message: "a.wav is empty." });
    const notWav = parseWavPick("notes.txt", new TextEncoder().encode("hello, this is not audio at all"));
    expect(notWav.ok).toBe(false);
    if (!notWav.ok) expect(notWav.message).toMatch(/^notes\.txt is not a WAV this app can replay \(Not a RIFF WAVE file\)/);
    expect(parseWavPick("quiet.wav", wav(0))).toEqual({ ok: false, message: "quiet.wav contains no audio." });
  });

  it("refuses formats the session cannot decode", () => {
    const result = parseWavPick("a.wav", wav(100, { bits: 24 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unsupported WAV format");
  });
});

describe("toSourceSpec", () => {
  it("maps live sources straight through and a file to its bytes", () => {
    expect(toSourceSpec({ kind: "mic" })).toEqual({ kind: "mic" });
    expect(toSourceSpec({ kind: "tab" })).toEqual({ kind: "tab" });
    const bytes = wav(10);
    expect(toSourceSpec({ kind: "file", pick: { name: "a.wav", bytes, sampleRate: 16000 } })).toEqual({ kind: "file", name: "a.wav", bytes });
  });

  it("has no spec for a file choice before a file is picked", () => {
    expect(toSourceSpec({ kind: "file", pick: null })).toBeNull();
  });
});
