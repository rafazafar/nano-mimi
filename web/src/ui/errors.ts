import type { SourceKind } from "./source";

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return typeof error === "string" && error !== "" ? error : "Something went wrong.";
}

export function describeStartError(error: unknown, source: SourceKind): string {
  const message = errorMessage(error);
  switch (errorName(error)) {
    case "NotAllowedError":
      return source === "tab"
        ? "Tab sharing was cancelled or blocked. Press Start, choose a tab, and tick “Share tab audio”."
        : source === "mic"
          ? "Microphone access was blocked. Allow it from the address bar, then press Start again."
          : message;
    case "NotFoundError":
      return source === "mic" ? "No microphone was found. Connect one and press Start again." : message;
    case "NotReadableError":
      return source === "mic" ? "The microphone is in use by another app. Close it there and press Start again." : message;
    case "AbortError":
      return "Capture was interrupted before it started. Press Start to try again.";
  }
  if (source === "tab" && /audio/i.test(message) && /(no|without|missing)/i.test(message)) {
    return "No audio was shared. In the share dialog choose a browser tab and tick “Share tab audio”, then press Start again.";
  }
  return message;
}
