import type { PairId } from "../core/pair";
import { h, setAttr, setHidden, setText } from "./dom";
import { icon } from "./icons";
import { MAX_ENTRIES, MAX_FIELD_CHARS, entryKind, type EntryError, type GlossaryEntry, type GlossaryStore } from "./glossaryStore";
import type { Messages } from "./i18n";
import { sourceLang, targetLang } from "./pairLang";

/** A Japanese-speech glossary target may be English or Japanese, so only the English-speech one is tagged. */
const targetFieldLang = (pair: PairId): string | undefined => (pair === "en-ja" ? targetLang(pair) : undefined);

interface EntryRow {
  readonly el: HTMLLIElement;
  readonly source: HTMLInputElement;
  readonly target: HTMLInputElement;
  readonly kind: HTMLElement;
  readonly remove: HTMLButtonElement;
}

export class GlossaryEditor {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly heads: HTMLElement;
  private readonly emptyLine: HTMLElement;
  private readonly sourceInput: HTMLInputElement;
  private readonly targetInput: HTMLInputElement;
  private readonly hint: HTMLElement;
  private readonly error: HTMLElement;
  private readonly unsaved: HTMLElement;
  private rows: EntryRow[] = [];

  constructor(
    private readonly store: GlossaryStore,
    private readonly m: Messages,
  ) {
    const { pair } = store;
    const text = m.glossary;
    const fields = text.fields[pair];
    this.list = h("ul", { class: "entries", "data-role": "entries" });
    this.emptyLine = h("p", { class: "note", "data-role": "glossary-empty" }, text.empty);
    this.sourceInput = h("input", { class: "input", name: "source", lang: sourceLang(pair), placeholder: fields.sourcePlaceholder, "aria-label": fields.sourceLabel, autocomplete: "off", spellcheck: "false" });
    this.targetInput = h("input", { class: "input", name: "target", lang: targetFieldLang(pair), placeholder: fields.targetPlaceholder, "aria-label": fields.targetLabel, autocomplete: "off", spellcheck: "false", oninput: () => this.paintHint() });
    this.hint = h("p", { class: "note", "data-role": "kind-hint", "aria-live": "polite" });
    this.error = h("p", { class: "notice notice-error", role: "alert", "data-role": "glossary-error", hidden: true });
    this.unsaved = h("p", { class: "note note-warn", "data-role": "glossary-unsaved", hidden: true }, text.unsaved);
    const form = h(
      "form",
      { class: "add-entry", "data-role": "add-entry", novalidate: true, onsubmit: (e: Event) => this.onAdd(e) },
      this.sourceInput,
      this.targetInput,
      h("button", { class: "btn", type: "submit" }, icon("plus"), text.add),
    );
    const columns = text.columns[pair];
    this.heads = h(
      "div",
      { class: "entry-heads", "data-role": "glossary-heads", "aria-hidden": "true" },
      h("span", {}, columns.source),
      h("span", { class: "arrow" }, "→"),
      h("span", {}, columns.target),
      h("span", {}),
    );
    this.el = h(
      "section",
      { class: "panel glossary", "data-role": "glossary", "aria-labelledby": "glossary-h" },
      h("h2", { id: "glossary-h" }, text.heading),
      h("p", { class: "help" }, text.help[pair]),
      this.heads,
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
    setText(this.error, error === null ? "" : this.errorText(error));
    setHidden(this.error, error === null);
  }

  private errorText(error: EntryError): string {
    const text = this.m.glossary.errors;
    switch (error) {
      case "empty-source":
        return text.emptySource[this.store.pair];
      case "empty-target":
        return text.emptyTarget;
      case "duplicate-source":
        return text.duplicateSource;
      case "too-long":
        return text.tooLong(MAX_FIELD_CHARS);
      case "full":
        return text.full(MAX_ENTRIES);
    }
  }

  private paintHint(): void {
    const { pair } = this.store;
    const target = this.targetInput.value.trim();
    setText(this.hint, target === "" ? this.m.glossary.idleHint[pair] : this.m.glossary.kind[pair][entryKind({ source: "", target }, pair)].hint);
  }

  private buildRow(index: number): EntryRow {
    const { pair } = this.store;
    const fields = this.m.glossary.fields[pair];
    const source = h("input", { class: "input entry-src", lang: sourceLang(pair), "aria-label": fields.entrySource(index + 1), autocomplete: "off", spellcheck: "false", onchange: () => this.onEdit(index) });
    const target = h("input", { class: "input entry-dst", lang: targetFieldLang(pair), "aria-label": fields.entryTarget(index + 1), autocomplete: "off", spellcheck: "false", onchange: () => this.onEdit(index) });
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

  private render(overwriteFocused = false): void {
    const entries = this.store.entries();
    if (entries.length !== this.rows.length) {
      this.rows = entries.map((_, i) => this.buildRow(i));
      this.list.replaceChildren(...this.rows.map((r) => r.el));
    }
    entries.forEach((entry, i) => this.paintRow(this.rows[i]!, entry, overwriteFocused));
    setHidden(this.emptyLine, entries.length > 0);
    setHidden(this.heads, entries.length === 0);
    setHidden(this.unsaved, this.store.isSaved());
    this.paintHint();
  }

  private paintRow(row: EntryRow, entry: GlossaryEntry, overwriteFocused: boolean): void {
    const { pair } = this.store;
    const kind = entryKind(entry, pair);
    const kindText = this.m.glossary.kind[pair][kind];
    if (overwriteFocused || document.activeElement !== row.source) row.source.value = entry.source;
    if (overwriteFocused || document.activeElement !== row.target) row.target.value = entry.target;
    setAttr(row.el, "data-kind", kind);
    setText(row.kind, kindText.label);
    setAttr(row.kind, "title", kindText.hint);
    setAttr(row.remove, "aria-label", this.m.glossary.remove(entry.source));
  }
}
