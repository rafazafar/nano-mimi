import type { CaptionState, Health, RowId } from "../pipeline";
import { formatBehind } from "./format";
import { openPictureInPicture, type PipHandle, type PipSupport } from "./pip";
import { createFrameScheduler, type FrameScheduler } from "./schedule";

export interface PipLine {
  readonly id: RowId;
  readonly text: string;
}

/** What the floating window shows: the last few settled English lines and the one line still in flux. */
export interface PipModel {
  /** Oldest first; the last is the newest and gets the emphasis. */
  readonly settled: readonly PipLine[];
  readonly provisional: { readonly text: string; readonly lang: "en" | "ja" } | null;
  readonly health: Health;
  readonly backlogS: number;
}

export const PIP_LINES = 3;

/**
 * Derives the window's content from the same caption state the transcript uses, so the two cannot disagree.
 * The provisional line is the row that will settle next (its streamed English, else its Japanese), or, when
 * no row is waiting, the draft's preview (else its Japanese).
 */
export function pipModel(state: CaptionState, max = PIP_LINES): PipModel {
  const settled: PipLine[] = [];
  for (let i = state.rows.length - 1; i >= 0 && settled.length < max; i--) {
    const row = state.rows[i]!;
    if (row.status === "settled" && row.en !== "") settled.unshift({ id: row.id, text: row.en });
  }
  let provisional: PipModel["provisional"] = null;
  const translating = state.rows.find((row) => row.status === "translating");
  if (translating !== undefined) {
    provisional = translating.streamed !== "" ? { text: translating.streamed, lang: "en" } : { text: translating.ja, lang: "ja" };
  } else if (state.draft !== null) {
    provisional = state.draft.previewEn !== "" ? { text: state.draft.previewEn, lang: "en" } : { text: state.draft.ja, lang: "ja" };
  }
  return { settled, provisional, health: state.health, backlogS: state.backlogS };
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

/** The floating window's DOM, built in its own document and patched from a `PipModel`. */
export class PipView {
  readonly el: HTMLElement;
  private readonly health: HTMLElement;
  private readonly lines: HTMLElement[];
  private readonly provisional: HTMLElement;
  private readonly provisionalText: HTMLElement;
  private readonly empty: HTMLElement;
  private newestId: RowId | null = null;

  constructor(doc: Document, max = PIP_LINES) {
    this.el = el(doc, "main", "pip");
    this.el.dataset["pip"] = "";
    this.health = el(doc, "p", "pip-health");
    this.health.setAttribute("role", "status");
    this.health.hidden = true;
    this.lines = Array.from({ length: max }, () => {
      const p = el(doc, "p", "pip-line");
      p.lang = "en";
      p.hidden = true;
      return p;
    });
    this.provisionalText = el(doc, "span", "pip-provisional-text");
    const caret = el(doc, "span", "caret");
    caret.setAttribute("aria-hidden", "true");
    this.provisional = el(doc, "p", "pip-provisional");
    this.provisional.dataset["provisional"] = "true";
    this.provisional.hidden = true;
    this.provisional.append(this.provisionalText, caret);
    this.empty = el(doc, "p", "pip-empty");
    this.empty.textContent = "Captions appear here as people speak.";
    const stack = el(doc, "div", "pip-lines");
    stack.append(...this.lines, this.provisional);
    this.el.append(this.health, stack, this.empty);
  }

  render(model: PipModel): void {
    const offset = this.lines.length - model.settled.length;
    this.lines.forEach((p, i) => {
      const line = model.settled[i - offset];
      p.hidden = line === undefined;
      if (line === undefined) return;
      if (p.textContent !== line.text) p.textContent = line.text;
      p.dataset["age"] = String(model.settled.length - 1 - (i - offset));
      p.dataset["id"] = String(line.id);
    });
    const newest = model.settled.at(-1)?.id ?? null;
    if (newest !== this.newestId) {
      this.newestId = newest;
      const p = this.lines.at(-1);
      if (p !== undefined && newest !== null) {
        p.classList.remove("enter");
        void p.offsetWidth;
        p.classList.add("enter");
      }
    }
    this.provisional.hidden = model.provisional === null;
    if (model.provisional !== null) {
      if (this.provisionalText.textContent !== model.provisional.text) this.provisionalText.textContent = model.provisional.text;
      this.provisional.lang = model.provisional.lang;
      this.provisional.dataset["lang"] = model.provisional.lang;
    }
    this.empty.hidden = model.settled.length > 0 || model.provisional !== null;
    const behind = model.health !== "ok";
    this.health.hidden = !behind;
    this.el.dataset["health"] = model.health;
    if (behind) this.health.textContent = formatBehind(model.backlogS, model.health);
  }
}

export type FloatingState =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "closed"; readonly error: string | null }
  | { readonly kind: "opening" }
  | { readonly kind: "open" };

export interface FloatingDeps {
  readonly support: PipSupport;
  readonly opener: Document;
  /** The live caption state; read on every render so the window never holds a copy that can go stale. */
  readonly captions: () => CaptionState;
  /** The button needs repainting: the state changed. */
  readonly changed: () => void;
}

/**
 * The floating caption window. It renders from the caption state in the page's memory, never from the page's
 * DOM, and schedules on the floating window's own frames with a timer behind them, so it keeps updating when
 * the tab that opened it is in the background.
 */
export class FloatingCaptions {
  private current: FloatingState;
  private handle: PipHandle | null = null;
  private view: PipView | null = null;
  private scheduler: FrameScheduler | null = null;

  constructor(private readonly deps: FloatingDeps) {
    this.current = deps.support.kind === "available" ? { kind: "closed", error: null } : { kind: "unavailable", reason: deps.support.reason };
  }

  get state(): FloatingState {
    return this.current;
  }

  /** Call from a click handler without awaiting anything first: the browser requires the user gesture. */
  async open(): Promise<void> {
    const { support } = this.deps;
    if (support.kind !== "available" || this.current.kind === "open" || this.current.kind === "opening") return;
    this.set({ kind: "opening" });
    const result = await openPictureInPicture(support.api, this.deps.opener, { onClosed: () => this.onClosed() });
    if (!result.ok) {
      this.set({ kind: "closed", error: result.message });
      return;
    }
    const win = result.handle.window;
    const view = new PipView(win.document);
    win.document.body.replaceChildren(view.el);
    this.handle = result.handle;
    this.view = view;
    this.scheduler = createFrameScheduler(win, () => this.paint(), 120);
    this.set({ kind: "open" });
    this.paint();
  }

  close(): void {
    this.handle?.close();
  }

  /** New caption state is available. */
  refresh(): void {
    this.scheduler?.schedule();
  }

  setTheme(theme: string | undefined): void {
    const root = this.handle?.window.document.documentElement;
    if (root === undefined) return;
    if (theme === undefined) delete root.dataset["theme"];
    else root.dataset["theme"] = theme;
  }

  private paint(): void {
    this.view?.render(pipModel(this.deps.captions()));
  }

  private onClosed(): void {
    this.scheduler?.cancel();
    this.scheduler = null;
    this.view = null;
    this.handle = null;
    this.set({ kind: "closed", error: null });
  }

  private set(next: FloatingState): void {
    this.current = next;
    this.deps.changed();
  }
}
