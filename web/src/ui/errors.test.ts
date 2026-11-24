import { describe, expect, it } from "vitest";
import { en } from "./i18n.en";
import { ja } from "./i18n.ja";
import { describeStartError, errorMessage } from "./errors";

const named = (name: string, message = "raw"): Error => Object.assign(new Error(message), { name });

describe("describeStartError", () => {
  it("explains a blocked microphone and a cancelled tab share differently", () => {
    expect(describeStartError(named("NotAllowedError"), "mic", en)).toMatch(/Microphone access was blocked/);
    expect(describeStartError(named("NotAllowedError"), "tab", en)).toMatch(/Share tab audio/);
  });

  it("names a missing or busy microphone", () => {
    expect(describeStartError(named("NotFoundError"), "mic", en)).toMatch(/No microphone/);
    expect(describeStartError(named("NotReadableError"), "mic", en)).toMatch(/in use/);
  });

  it("turns a tab share without audio into the instruction that fixes it", () => {
    const text = describeStartError(new Error("The shared tab has no audio track"), "tab", en);
    expect(text).toMatch(/tick “Share tab audio”/);
  });

  it("keeps the thrown message when nothing friendlier is known", () => {
    expect(describeStartError(new Error("WAV has no data chunk"), "file", en)).toBe("WAV has no data chunk");
    expect(describeStartError(named("NotAllowedError", "denied by policy"), "file", en)).toBe("denied by policy");
    expect(describeStartError(new Error("The shared tab has no audio track"), "mic", en)).toBe("The shared tab has no audio track");
  });

  it("copes with a thrown non-Error", () => {
    expect(describeStartError("boom", "mic", en)).toBe("boom");
    expect(describeStartError(undefined, "mic", en)).toBe("Something went wrong.");
    expect(errorMessage(new Error(""), en)).toBe("Something went wrong.");
  });

  it("speaks Japanese when asked", () => {
    expect(describeStartError(named("NotFoundError"), "mic", ja)).toBe(ja.errors.micMissing);
    expect(errorMessage(undefined, ja)).toBe(ja.errors.unknown);
  });
});
