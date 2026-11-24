import type { Messages } from "./i18n";
import type { SourceKind } from "./source";

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
}

export function errorMessage(error: unknown, m: Messages): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return typeof error === "string" && error !== "" ? error : m.errors.unknown;
}

export function describeStartError(error: unknown, source: SourceKind, m: Messages): string {
  const message = errorMessage(error, m);
  switch (errorName(error)) {
    case "NotAllowedError":
      return source === "tab" ? m.errors.tabCancelled : source === "mic" ? m.errors.micBlocked : message;
    case "NotFoundError":
      return source === "mic" ? m.errors.micMissing : message;
    case "NotReadableError":
      return source === "mic" ? m.errors.micBusy : message;
    case "AbortError":
      return m.errors.captureAborted;
  }
  if (source === "tab" && /audio/i.test(message) && /(no|without|missing)/i.test(message)) return m.errors.noTabAudio;
  return message;
}
