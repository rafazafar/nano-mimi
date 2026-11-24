import { describe, expect, it, vi } from "vitest";
import { en } from "./i18n.en";
import { ja } from "./i18n.ja";
import { describePipError, pipUnavailableText, detectPip, openPictureInPicture, type DocumentPipApi } from "./pip";

const apiWith = (requestWindow: DocumentPipApi["requestWindow"], window: Window | null = null): DocumentPipApi => ({ requestWindow, window });

describe("detectPip", () => {
  it("is unavailable where the browser has no Document Picture-in-Picture", () => {
    expect(detectPip({})).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(detectPip({ documentPictureInPicture: undefined })).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(detectPip({ documentPictureInPicture: {} })).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(detectPip({ documentPictureInPicture: "yes" })).toEqual({ kind: "unavailable", reason: "unsupported" });
  });

  it("is unavailable on an insecure page even when the API exists", () => {
    const api = apiWith(() => Promise.reject(new Error("unused")));
    expect(detectPip({ documentPictureInPicture: api, isSecureContext: false })).toEqual({ kind: "unavailable", reason: "insecure" });
  });

  it("is available with a requestWindow function", () => {
    const api = apiWith(() => Promise.reject(new Error("unused")));
    expect(detectPip({ documentPictureInPicture: api, isSecureContext: true })).toEqual({ kind: "available", api });
    expect(detectPip({ documentPictureInPicture: api }).kind).toBe("available");
  });
});

describe("openPictureInPicture", () => {
  const opener = {} as Document;

  it("turns a missing user gesture into a prompt to click again", async () => {
    const denied = Object.assign(new Error("Requires user activation"), { name: "NotAllowedError" });
    const result = await openPictureInPicture(apiWith(() => Promise.reject(denied)), opener, { messages: en, onClosed: () => undefined });
    expect(result).toEqual({ ok: false, message: describePipError(denied, en) });
    expect(describePipError(denied, en)).toMatch(/click/i);
  });

  it("never throws, whatever the browser rejects with", async () => {
    for (const reason of [new Error("boom"), "string", undefined, null, { name: "SecurityError" }]) {
      const result = await openPictureInPicture(apiWith(() => Promise.reject(reason)), opener, { messages: en, onClosed: () => undefined });
      expect(result.ok).toBe(false);
    }
  });

  it("closes a window left over from an earlier mount before asking for a new one", async () => {
    const stale = { closed: false, close: vi.fn() } as unknown as Window;
    const request = vi.fn(() => Promise.reject(new Error("stop here")));
    await openPictureInPicture(apiWith(request, stale), opener, { messages: en, onClosed: () => undefined });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("asks for a window of the given size", async () => {
    const request = vi.fn(() => Promise.reject(new Error("stop here")));
    await openPictureInPicture(apiWith(request), opener, { messages: en, onClosed: () => undefined, width: 500, height: 200 });
    expect(request).toHaveBeenCalledWith({ width: 500, height: 200 });
  });
});

describe("pip messages", () => {
  it("words the unavailable reasons in each language", () => {
    expect(pipUnavailableText("unsupported", en)).toMatch(/Chrome or Edge 116/);
    expect(pipUnavailableText("insecure", ja)).toBe(ja.errors.pipInsecure);
    expect(describePipError({ name: "NotSupportedError" }, ja)).toBe(ja.errors.pipUnsupported);
    expect(describePipError(new Error("boom"), en)).toBe("Could not open the floating window: boom");
    expect(describePipError("x", en)).toBe("Could not open the floating window.");
  });
});
