/** The slice of Document Picture-in-Picture the app uses (Chrome and Edge 116+). */
export interface DocumentPipApi {
  requestWindow(options?: { readonly width?: number; readonly height?: number }): Promise<Window>;
  /** The window this page opened, while it is open. */
  readonly window?: Window | null;
}

export type PipSupport =
  | { readonly kind: "available"; readonly api: DocumentPipApi }
  | { readonly kind: "unavailable"; readonly reason: string };

export const PIP_UNSUPPORTED = "Floating captions need Chrome or Edge 116 or later.";
export const PIP_INSECURE = "Floating captions need a secure page (https or localhost).";

/** Looks for the API on `host` (the `window`) without assuming its shape, since a page can also run in other browsers. */
export function detectPip(host: { readonly documentPictureInPicture?: unknown; readonly isSecureContext?: boolean }): PipSupport {
  const api = host.documentPictureInPicture;
  if (typeof api !== "object" || api === null || typeof (api as { requestWindow?: unknown }).requestWindow !== "function") {
    return { kind: "unavailable", reason: PIP_UNSUPPORTED };
  }
  if (host.isSecureContext === false) return { kind: "unavailable", reason: PIP_INSECURE };
  return { kind: "available", api: api as DocumentPipApi };
}

export interface PipHandle {
  readonly window: Window;
  close(): void;
}

export type PipOpenResult = { readonly ok: true; readonly handle: PipHandle } | { readonly ok: false; readonly message: string };

/** The reason `requestWindow` refused, in words a viewer can act on. */
export function describePipError(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
      return "The browser only opens the floating window straight from a click. Press the button again.";
    case "SecurityError":
      return PIP_INSECURE;
    case "NotSupportedError":
      return PIP_UNSUPPORTED;
    default:
      return `Could not open the floating window${error instanceof Error && error.message !== "" ? `: ${error.message}` : "."}`;
  }
}

/**
 * Copies the page's styles into another document so the floating window looks like the app. Same-origin
 * sheets are copied rule by rule; a sheet the browser will not let us read is linked instead.
 */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      to.head.append(style);
    } catch {
      if (sheet.href !== null) {
        const link = to.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        to.head.append(link);
      }
    }
  }
}

export interface OpenPipOptions {
  /** Called once when the window goes away, whether the viewer closed it or the page did. */
  readonly onClosed: () => void;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Opens the floating window and readies its document: styles copied, theme carried over, `onClosed` wired
 * to `pagehide`. Needs a user gesture, so call it from a click handler before any `await`. Never throws:
 * a refusal comes back as a message for the UI to show beside the button.
 */
export async function openPictureInPicture(api: DocumentPipApi, opener: Document, options: OpenPipOptions): Promise<PipOpenResult> {
  try {
    // A window left over from an earlier mount would otherwise close under us after we hand out the new one.
    const stale = api.window;
    if (stale !== undefined && stale !== null && !stale.closed) stale.close();
    const win = await api.requestWindow({ width: options.width ?? 460, height: options.height ?? 320 });
    copyStyles(opener, win.document);
    win.document.title = "MimiVox captions";
    win.document.documentElement.lang = "en";
    const theme = opener.documentElement.dataset["theme"];
    if (theme !== undefined) win.document.documentElement.dataset["theme"] = theme;
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      options.onClosed();
    };
    win.addEventListener("pagehide", finish, { once: true });
    return {
      ok: true,
      handle: {
        window: win,
        close() {
          try {
            win.close();
          } catch {
            // Already gone.
          }
          finish();
        },
      },
    };
  } catch (error) {
    return { ok: false, message: describePipError(error) };
  }
}
