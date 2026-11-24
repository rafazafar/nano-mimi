import { h, setAttr, setHidden, setText } from "./dom";
import { icon } from "./icons";
import { ENTRY_ERROR_TEXT, entryKind, type EntryError, type EntryKind, type GlossaryEntry, type GlossaryStore } from "./glossaryStore";

const KIND_LABEL: Readonly<Record<EntryKind, string>> = { term: "Term", "asr-fix": "Spelling fix" };

const KIND_HINT: Readonly<Record<EntryKind, string>> = {
  term: "Term: this wording is used in the English.",
  "asr-fix": "Spelling fix: the Japanese is corrected before translation.",
};

const IDLE_HINT = "A Japanese replacement fixes how speech recognition spells a word. Any other replacement is used as written in the English.";

interface EntryRow {
  readonly el: HTMLLIElement;
  readonly source: HTMLInputElement;
  readonly target: HTMLInputElement;
  readonly kind: HTMLElement;
  readonly remove: HTMLButtonElement;
}

/**
 * Add, edit and remove glossary rows. Each commit goes to the store, which persists it and which the session
 * reads before every line. Order is the store's insertion order, shown as listed because it breaks ties
 * between equally long sources.
 */
export class GlossaryEditor {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly emptyLine: HTMLElement;
  private readonly sourceInput: HTMLInputElement;
  private readonly targetInput: HTMLInputElement;
  private readonly hint: HTMLElement;
  private readonly error: HTMLElement;
  private readonly unsaved: HTMLElement;
  private rows: EntryRow[] = [];

  constructor(private readonly store: GlossaryStore) {
    this.list = h("ul", { class: "entries", "data-role": "entries" });
    this.emptyLine = h("p", { class: "note", "data-role": "glossary-empty" }, "No entries yet. Add the names and terms your meetings use.");
    this.sourceInput = h("input", { class: "input", name: "source", lang: "ja", placeholder: "Japanese as heard", "aria-label": "Japanese to look for", autocomplete: "off", spellcheck: "false" });
    this.targetInput = h("input", { class: "input", name: "target", placeholder: "Replace with", "aria-label": "Replacement", autocomplete: "off", spellcheck: "false", oninput: () => this.paintHint() });
    this.hint = h("p", { class: "note", "data-role": "kind-hint", "aria-live": "polite" });
    this.error = h("p", { class: "notice notice-error", role: "alert", "data-role": "glossary-error", hidden: true });
    this.unsaved = h("p", { class: "note note-warn", "data-role": "glossary-unsaved", hidden: true }, "This browser would not save the glossary. Your entries last until you close the tab.");
    const form = h(
      "form",
      { class: "add-entry", "data-role": "add-entry", novalidate: true, onsubmit: (e: Event) => this.onAdd(e) },
      this.sourceInput,
      this.targetInput,
      h("button", { class: "btn", type: "submit" }, icon("plus"), "Add"),
    );
    this.el = h(
      "section",
      { class: "panel glossary", "data-role": "glossary", "aria-labelledby": "glossary-h" },
      h("h2", { id: "glossary-h" }, "Glossary"),
      h("p", { class: "help" }, "Fix words recognition gets wrong, or pin how a term is written in English. Edits apply from the next caption."),
      this.list,
      this.emptyLine,
      form,
      this.hint,
      this.error,
      this.unsaved,
    );
    store.subscribe(() => this.render());
    this.render();
  }

  private onAdd(event: Event): void {
    event.preventDefault();
    const error = this.store.add({ source: this.sourceInput.value, target: this.targetInput.value });
    if (error !== null) return this.showError(error);
    this.showError(null);
    this.sourceInput.value = "";
    this.targetInput.value = "";
    this.paintHint();
    this.sourceInput.focus();
  }

  private showError(error: EntryError | null): void {
    setText(this.error, error === null ? "" : ENTRY_ERROR_TEXT[error]);
    setHidden(this.error, error === null);
  }

  private paintHint(): void {
    const target = this.targetInput.value.trim();
    setText(this.hint, target === "" ? IDLE_HINT : KIND_HINT[entryKind({ source: "", target })]);
  }

  private buildRow(index: number): EntryRow {
    const source = h("input", { class: "input entry-src", lang: "ja", "aria-label": `Japanese for entry ${index + 1}`, autocomplete: "off", spellcheck: "false", onchange: () => this.onEdit(index) });
    const target = h("input", { class: "input entry-dst", "aria-label": `Replacement for entry ${index + 1}`, autocomplete: "off", spellcheck: "false", onchange: () => this.onEdit(index) });
    const kind = h("span", { class: "kind", "data-role": "kind" });
    const remove = h("button", { class: "btn btn-quiet btn-icon", type: "button", "data-role": "remove", onclick: () => this.onRemove(index) }, icon("x"));
    const el = h("li", { class: "entry", "data-index": String(index) }, source, h("span", { class: "arrow", "aria-hidden": "true" }, "→"), target, remove, kind);
    return { el, source, target, kind, remove };
  }

  private onEdit(index: number): void {
    const row = this.rows[index];
    if (row === undefined) return;
    const error = this.store.update(index, { source: row.source.value, target: row.target.value });
    this.showError(error);
    if (error !== null) this.render(true);
  }

  private onRemove(index: number): void {
    this.showError(null);
    this.store.remove(index);
  }

  /** `force` overwrites the field being edited, to revert a rejected edit. */
  private render(force = false): void {
    const entries = this.store.entries();
    if (entries.length !== this.rows.length) {
      this.rows = entries.map((_, i) => this.buildRow(i));
      this.list.replaceChildren(...this.rows.map((r) => r.el));
    }
    entries.forEach((entry, i) => this.paintRow(this.rows[i]!, entry, force));
    setHidden(this.emptyLine, entries.length > 0);
    setHidden(this.unsaved, this.store.isSaved());
    this.paintHint();
  }

  private paintRow(row: EntryRow, entry: GlossaryEntry, force: boolean): void {
    const kind = entryKind(entry);
    if (force || document.activeElement !== row.source) row.source.value = entry.source;
    if (force || document.activeElement !== row.target) row.target.value = entry.target;
    setAttr(row.el, "data-kind", kind);
    setText(row.kind, KIND_LABEL[kind]);
    setAttr(row.kind, "title", KIND_HINT[kind]);
    setAttr(row.remove, "aria-label", `Remove ${entry.source}`);
  }
}
