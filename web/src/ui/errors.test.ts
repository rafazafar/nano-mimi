import { describe, expect, it } from "vitest";
import { describeStartError, errorMessage } from "./errors";

const named = (name: string, message = "raw"): Error => Object.assign(new Error(message), { name });

describe("describeStartError", () => {
  it("explains a blocked microphone and a cancelled tab share differently", () => {
    expect(describeStartError(named("NotAllowedError"), "mic")).toMatch(/Microphone access was blocked/);
    expect(describeStartError(named("NotAllowedError"), "tab")).toMatch(/Share tab audio/);
  });

  it("names a missing or busy microphone", () => {
    expect(describeStartError(named("NotFoundError"), "mic")).toMatch(/No microphone/);
    expect(describeStartError(named("NotReadableError"), "mic")).toMatch(/in use/);
  });

  it("turns a tab share without audio into the instruction that fixes it", () => {
    const text = describeStartError(new Error("The shared tab has no audio track"), "tab");
    expect(text).toMatch(/tick “Share tab audio”/);
  });

  it("keeps the thrown message when nothing friendlier is known", () => {
    expect(describeStartError(new Error("WAV has no data chunk"), "file")).toBe("WAV has no data chunk");
    expect(describeStartError(named("NotAllowedError", "denied by policy"), "file")).toBe("denied by policy");
    expect(describeStartError(new Error("The shared tab has no audio track"), "mic")).toBe("The shared tab has no audio track");
  });

  it("copes with a thrown non-Error", () => {
    expect(describeStartError("boom", "mic")).toBe("boom");
    expect(describeStartError(undefined, "mic")).toBe("Something went wrong.");
    expect(errorMessage(new Error(""))).toBe("Something went wrong.");
  });
});
