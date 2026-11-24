import { isAsrFix, type Glossary } from "../core/glossary";
import { readItem, writeItem, type KeyValueStorage } from "./storage";

export const GLOSSARY_KEY = "mimivox.glossary.v1";
const MAX_ENTRIES = 500;
const MAX_FIELD_CHARS = 200;

export interface GlossaryEntry {
  readonly source: string;
  readonly target: string;
}

/** A Japanese target rewrites how ASR spelled a word; any other target fixes the English wording. */
export type EntryKind = "term" | "asr-fix";

export const entryKind = (entry: GlossaryEntry): EntryKind => (isAsrFix(entry.target) ? "asr-fix" : "term");

export type EntryError = "empty-source" | "empty-target" | "duplicate-source" | "too-long" | "full";

export const ENTRY_ERROR_TEXT: Readonly<Record<EntryError, string>> = {
  "empty-source": "Enter the Japanese to look for.",
  "empty-target": "Enter what it should become.",
  "duplicate-source": "That source is already in the glossary.",
  "too-long": `Keep each side under ${MAX_FIELD_CHARS} characters.`,
  full: `The glossary holds at most ${MAX_ENTRIES} entries.`,
};

function clean(entry: GlossaryEntry): GlossaryEntry {
  return { source: entry.source.trim(), target: entry.target.trim() };
}

/**
 * The stored form is `{"version":1,"entries":[{source,target}]}`. Storage is outside the app's control
 * (other tabs, hand edits, older builds), so every field is checked and bad entries are dropped one by one:
 * a corrupt file yields what is salvageable, never an exception. A repeated source keeps its first entry.
 */
export function parseStoredGlossary(raw: string | null): GlossaryEntry[] {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const { version, entries } = json as { version?: unknown; entries?: unknown };
  if (version !== 1 || !Array.isArray(entries)) return [];
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { source, target } = item as { source?: unknown; target?: unknown };
    if (typeof source !== "string" || typeof target !== "string") continue;
    const entry = clean({ source, target });
    if (entry.source === "" || entry.target === "") continue;
    if (entry.source.length > MAX_FIELD_CHARS || entry.target.length > MAX_FIELD_CHARS) continue;
    if (seen.has(entry.source)) continue;
    seen.add(entry.source);
    out.push(entry);
    if (out.length === MAX_ENTRIES) break;
  }
  return out;
}

export function serializeGlossary(entries: readonly GlossaryEntry[]): string {
  return JSON.stringify({ version: 1, entries: entries.map(({ source, target }) => ({ source, target })) });
}

/** Insertion order is meaningful: it breaks ties between sources of equal length, so the map keeps it. */
export function toGlossary(entries: readonly GlossaryEntry[]): Glossary {
  return new Map(entries.map((e) => [e.source, e.target]));
}

/** What is wrong with `candidate` as the entry at `index` (`entries.length` for a new one), or null. */
export function validateEntry(entries: readonly GlossaryEntry[], candidate: GlossaryEntry, index: number): EntryError | null {
  const entry = clean(candidate);
  if (entry.source === "") return "empty-source";
  if (entry.target === "") return "empty-target";
  if (entry.source.length > MAX_FIELD_CHARS || entry.target.length > MAX_FIELD_CHARS) return "too-long";
  if (index >= entries.length && entries.length >= MAX_ENTRIES) return "full";
  if (entries.some((e, i) => i !== index && e.source === entry.source)) return "duplicate-source";
  return null;
}

export class GlossaryStore {
  private list: readonly GlossaryEntry[];
  private map: Glossary;
  private readonly listeners = new Set<() => void>();
  private saved = true;

  constructor(private readonly storage: KeyValueStorage) {
    this.list = parseStoredGlossary(readItem(storage, GLOSSARY_KEY));
    this.map = toGlossary(this.list);
  }

  entries(): readonly GlossaryEntry[] {
    return this.list;
  }

  /** The live view the session reads; a new map only when something changed. */
  glossary(): Glossary {
    return this.map;
  }

  /** False when the browser refused the last write, so the edit lasts only until the tab closes. */
  isSaved(): boolean {
    return this.saved;
  }

  add(entry: GlossaryEntry): EntryError | null {
    const error = validateEntry(this.list, entry, this.list.length);
    if (error !== null) return error;
    this.commit([...this.list, clean(entry)]);
    return null;
  }

  /** Replaces the entry in place, so its place in the tie-break order is unchanged. */
  update(index: number, entry: GlossaryEntry): EntryError | null {
    if (index < 0 || index >= this.list.length) return null;
    const error = validateEntry(this.list, entry, index);
    if (error !== null) return error;
    this.commit(this.list.map((e, i) => (i === index ? clean(entry) : e)));
    return null;
  }

  remove(index: number): void {
    if (index < 0 || index >= this.list.length) return;
    this.commit(this.list.filter((_, i) => i !== index));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: readonly GlossaryEntry[]): void {
    this.list = next;
    this.map = toGlossary(next);
    this.saved = writeItem(this.storage, GLOSSARY_KEY, serializeGlossary(next));
    for (const listener of this.listeners) listener();
  }
}
