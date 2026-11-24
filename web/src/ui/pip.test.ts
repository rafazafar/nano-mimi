import { describe, expect, it, vi } from "vitest";
import { PIP_INSECURE, PIP_UNSUPPORTED, describePipError, detectPip, openPictureInPicture, type DocumentPipApi } from "./pip";

const apiWith = (requestWindow: DocumentPipApi["requestWindow"], window: Window | null = null): DocumentPipApi => ({ requestWindow, window });

describe("detectPip", () => {
  it("is unavailable where the browser has no Document Picture-in-Picture", () => {
    expect(detectPip({})).toEqual({ kind: "unavailable", reason: PIP_UNSUPPORTED });
    expect(detectPip({ documentPictureInPicture: undefined })).toEqual({ kind: "unavailable", reason: PIP_UNSUPPORTED });
    expect(detectPip({ documentPictureInPicture: {} })).toEqual({ kind: "unavailable", reason: PIP_UNSUPPORTED });
    expect(detectPip({ documentPictureInPicture: "yes" })).toEqual({ kind: "unavailable", reason: PIP_UNSUPPORTED });
  });

  it("is unavailable on an insecure page even when the API exists", () => {
    const api = apiWith(() => Promise.reject(new Error("unused")));
    expect(detectPip({ documentPictureInPicture: api, isSecureContext: false })).toEqual({ kind: "unavailable", reason: PIP_INSECURE });
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
    const result = await openPictureInPicture(apiWith(() => Promise.reject(denied)), opener, { onClosed: () => undefined });
    expect(result).toEqual({ ok: false, message: describePipError(denied) });
    expect(describePipError(denied)).toMatch(/click/i);
  });

  it("never throws, whatever the browser rejects with", async () => {
    for (const reason of [new Error("boom"), "string", undefined, null, { name: "SecurityError" }]) {
      const result = await openPictureInPicture(apiWith(() => Promise.reject(reason)), opener, { onClosed: () => undefined });
      expect(result.ok).toBe(false);
    }
  });

  it("closes a window left over from an earlier mount before asking for a new one", async () => {
    const stale = { closed: false, close: vi.fn() } as unknown as Window;
    const request = vi.fn(() => Promise.reject(new Error("stop here")));
    await openPictureInPicture(apiWith(request, stale), opener, { onClosed: () => undefined });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("asks for a window of the given size", async () => {
    const request = vi.fn(() => Promise.reject(new Error("stop here")));
    await openPictureInPicture(apiWith(request), opener, { onClosed: () => undefined, width: 500, height: 200 });
    expect(request).toHaveBeenCalledWith({ width: 500, height: 200 });
  });
});
