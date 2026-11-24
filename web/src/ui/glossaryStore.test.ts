import { describe, expect, it } from "vitest";
import { applyGlossary } from "../core/glossary";
import { asJaText } from "../core/types";
import { EN_JA_GLOSSARY_KEY, GLOSSARY_KEY, GlossaryStore, entryKind, glossaryKey, parseStoredGlossary, serializeGlossary, validateEntry } from "./glossaryStore";
import { MemoryStorage, type KeyValueStorage } from "./storage";

const stored = (entries: unknown, version: unknown = 1): string => JSON.stringify({ version, entries });

describe("parseStoredGlossary", () => {
  it("round-trips what serializeGlossary writes, in order", () => {
    const entries = [
      { source: "ミミボックス", target: "MimiVox" },
      { source: "かいぎ", target: "会議" },
    ];
    expect(parseStoredGlossary(serializeGlossary(entries))).toEqual(entries);
  });

  it("is empty for nothing, garbage, the wrong shape or another version", () => {
    expect(parseStoredGlossary(null)).toEqual([]);
    expect(parseStoredGlossary("{not json")).toEqual([]);
    expect(parseStoredGlossary("42")).toEqual([]);
    expect(parseStoredGlossary("null")).toEqual([]);
    expect(parseStoredGlossary(stored("nope"))).toEqual([]);
    expect(parseStoredGlossary(stored([{ source: "a", target: "b" }], 2))).toEqual([]);
  });

  it("salvages valid entries around bad ones", () => {
    const raw = stored([
      { source: "ミミ", target: "Mimi" },
      null,
      "text",
      { source: 3, target: "x" },
      { source: "x" },
      { source: "  ", target: "blank source" },
      { source: "空", target: "" },
      { source: " 会議 ", target: " meeting " },
    ]);
    expect(parseStoredGlossary(raw)).toEqual([
      { source: "ミミ", target: "Mimi" },
      { source: "会議", target: "meeting" },
    ]);
  });

  it("keeps the first of a repeated source and drops oversized fields", () => {
    const raw = stored([
      { source: "A", target: "first" },
      { source: "A", target: "second" },
      { source: "B", target: "x".repeat(201) },
    ]);
    expect(parseStoredGlossary(raw)).toEqual([{ source: "A", target: "first" }]);
  });
});

describe("validateEntry", () => {
  const entries = [
    { source: "A", target: "a" },
    { source: "B", target: "b" },
  ];

  it("rejects empty sides and duplicate sources", () => {
    expect(validateEntry(entries, { source: " ", target: "x" }, 2)).toBe("empty-source");
    expect(validateEntry(entries, { source: "C", target: "" }, 2)).toBe("empty-target");
    expect(validateEntry(entries, { source: "B", target: "x" }, 2)).toBe("duplicate-source");
  });

  it("lets an entry keep its own source when edited", () => {
    expect(validateEntry(entries, { source: "B", target: "bee" }, 1)).toBeNull();
    expect(validateEntry(entries, { source: "A", target: "bee" }, 1)).toBe("duplicate-source");
  });
});

describe("entryKind", () => {
  it("calls a Japanese target an ASR spelling fix and any other a term", () => {
    expect(entryKind({ source: "かいぎ", target: "会議" }, "ja-en")).toBe("asr-fix");
    expect(entryKind({ source: "ミミボックス", target: "MimiVox" }, "ja-en")).toBe("term");
    expect(entryKind({ source: "ミミ", target: "Mimi ミミ" }, "ja-en")).toBe("asr-fix");
  });
});

describe("GlossaryStore", () => {
  it("persists every change under the v1 key and reloads it", () => {
    const storage = new MemoryStorage();
    const store = new GlossaryStore(storage, "ja-en");
    expect(store.add({ source: "ミミボックス", target: "MimiVox" })).toBeNull();
    expect(store.add({ source: "かいぎ", target: "会議" })).toBeNull();
    expect(JSON.parse(storage.getItem(GLOSSARY_KEY) ?? "null")).toEqual({
      version: 1,
      entries: [
        { source: "ミミボックス", target: "MimiVox" },
        { source: "かいぎ", target: "会議" },
      ],
    });
    expect(new GlossaryStore(storage, "ja-en").entries()).toEqual(store.entries());
  });

  it("keeps insertion order in the map so equal-length sources tie-break the same way every time", () => {
    const store = new GlossaryStore(new MemoryStorage(), "ja-en");
    store.add({ source: "あい", target: "first" });
    store.add({ source: "うえ", target: "second" });
    expect([...store.glossary().keys()]).toEqual(["あい", "うえ"]);
    store.update(0, { source: "あい", target: "first!" });
    expect([...store.glossary().entries()]).toEqual([
      ["あい", "first!"],
      ["うえ", "second"],
    ]);
    store.remove(0);
    store.add({ source: "あい", target: "last" });
    expect([...store.glossary().keys()]).toEqual(["うえ", "あい"]);
  });

  it("feeds the pipeline's glossary function, so an edit applies to the next line", () => {
    const store = new GlossaryStore(new MemoryStorage(), "ja-en");
    const read = (): ReadonlyMap<string, string> => store.glossary();
    expect(applyGlossary(asJaText("ミミボックスです"), read())).toBe("ミミボックスです");
    store.add({ source: "ミミボックス", target: "MimiVox" });
    expect(applyGlossary(asJaText("ミミボックスです"), read())).toBe("MimiVoxです");
  });

  it("reports a rejected edit and leaves the list alone", () => {
    const store = new GlossaryStore(new MemoryStorage(), "ja-en");
    store.add({ source: "A", target: "a" });
    expect(store.add({ source: "A", target: "again" })).toBe("duplicate-source");
    expect(store.update(0, { source: "A", target: " " })).toBe("empty-target");
    expect(store.entries()).toEqual([{ source: "A", target: "a" }]);
  });

  it("notifies subscribers once per change until they unsubscribe", () => {
    const store = new GlossaryStore(new MemoryStorage(), "ja-en");
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.add({ source: "A", target: "a" });
    store.remove(0);
    off();
    store.add({ source: "B", target: "b" });
    expect(calls).toBe(2);
  });

  it("starts empty from corrupt storage and recovers on the next write", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_KEY, "{{{");
    const store = new GlossaryStore(storage, "ja-en");
    expect(store.entries()).toEqual([]);
    store.add({ source: "A", target: "a" });
    expect(new GlossaryStore(storage, "ja-en").entries()).toEqual([{ source: "A", target: "a" }]);
  });

  it("keeps working in memory when the browser refuses the write, and says so", () => {
    const refusing: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const store = new GlossaryStore(refusing, "ja-en");
    expect(store.entries()).toEqual([]);
    expect(store.add({ source: "A", target: "a" })).toBeNull();
    expect(store.glossary().get("A")).toBe("a");
    expect(store.isSaved()).toBe(false);
  });
});

describe("per-pair glossaries", () => {
  it("keeps the original key for Japanese speech and a separate one for English speech", () => {
    expect(glossaryKey("ja-en")).toBe("mimivox.glossary.v1");
    expect(glossaryKey("en-ja")).toBe(EN_JA_GLOSSARY_KEY);
    expect(EN_JA_GLOSSARY_KEY).not.toBe(GLOSSARY_KEY);
  });

  it("does not mix the two lists", () => {
    const storage = new MemoryStorage();
    new GlossaryStore(storage, "ja-en").add({ source: "ミミ", target: "Mimi" });
    const english = new GlossaryStore(storage, "en-ja");
    expect(english.entries()).toEqual([]);
    english.add({ source: "standup", target: "朝会" });
    expect(new GlossaryStore(storage, "ja-en").entries()).toEqual([{ source: "ミミ", target: "Mimi" }]);
    expect(new GlossaryStore(storage, "en-ja").entries()).toEqual([{ source: "standup", target: "朝会" }]);
  });

  it("reads a glossary saved before the second direction existed as the Japanese-speech one", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_KEY, serializeGlossary([{ source: "かいぎ", target: "会議" }]));
    expect(new GlossaryStore(storage, "ja-en").entries()).toEqual([{ source: "かいぎ", target: "会議" }]);
    expect(new GlossaryStore(storage, "en-ja").entries()).toEqual([]);
  });

  it("treats every English-speech entry as a term, even with a Japanese target", () => {
    expect(entryKind({ source: "standup", target: "朝会" }, "en-ja")).toBe("term");
  });
});
