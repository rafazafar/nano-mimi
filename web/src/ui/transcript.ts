import type { CaptionRow, CaptionState, Draft, RowId, Timing } from "../pipeline";
import { h, setAttr, setHidden, setText } from "./dom";
import { formatSeconds, formatTimestamp } from "./format";
import { icon } from "./icons";

/** What one row shows right now, derived from the reducer's row so the DOM code has no decisions left to make. */
export interface RowView {
  readonly time: string;
  readonly ja: string;
  readonly jaProvisional: boolean;
  /** The English to show: the settled line, or what the translator has streamed so far. */
  readonly en: string;
  readonly enProvisional: boolean;
  /** Said where `en` is still empty. */
  readonly placeholder: string;
  /** True while anything on the row can still change. */
  readonly provisional: boolean;
  readonly revising: boolean;
  readonly revisions: number;
  readonly source: CaptionRow["source"];
}

export function rowView(row: CaptionRow): RowView {
  const time = formatTimestamp(row.timelineS);
  if (row.status === "translating") {
    return { time, ja: row.ja, jaProvisional: false, en: row.streamed, enProvisional: true, placeholder: "Translating", provisional: true, revising: false, revisions: row.revisions, source: row.source };
  }
  if (row.revising !== null) {
    const streaming = row.revising.streamed !== "";
    return {
      time,
      ja: row.revising.ja,
      jaProvisional: true,
      en: streaming ? row.revising.streamed : row.en,
      enProvisional: streaming,
      placeholder: "",
      provisional: true,
      revising: true,
      revisions: row.revisions,
      source: row.source,
    };
  }
  const failed = row.en === "" && row.source === "failed";
  return {
    time,
    ja: row.ja,
    jaProvisional: false,
    en: row.en,
    enProvisional: false,
    placeholder: failed ? "Translation unavailable" : "",
    provisional: false,
    revising: false,
    revisions: row.revisions,
    source: row.source,
  };
}

export interface DraftView {
  readonly time: string;
  readonly ja: string;
  readonly en: string;
}

export const draftView = (draft: Draft): DraftView => ({ time: formatTimestamp(draft.timelineS), ja: draft.ja, en: draft.previewEn });

/** The label and value pairs of a row's expandable timing detail. */
export function timingRows(timing: Timing, source: CaptionRow["source"]): readonly (readonly [string, string])[] {
  return [
    ["English from", source ?? "-"],
    ["VAD wait", formatSeconds(timing.vadWaitS)],
    ["Queue wait", formatSeconds(timing.queueWaitS)],
    ["Speech recognition", formatSeconds(timing.asrS)],
    ["Translation", formatSeconds(timing.mtS)],
    ["Perceived", formatSeconds(timing.perceivedS)],
    ["End to end", formatSeconds(timing.endToEndS)],
  ];
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** Within `threshold` pixels of the end counts as following the live edge. */
export function isNearBottom(m: ScrollMetrics, threshold = 48): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

interface RowParts {
  readonly el: HTMLElement;
  readonly time: HTMLElement;
  readonly en: HTMLElement;
  readonly enText: HTMLElement;
  readonly ja: HTMLElement;
  readonly tagRevising: HTMLElement;
  readonly tagRevised: HTMLElement;
  readonly timing: HTMLDetailsElement;
  readonly timingTotal: HTMLElement;
  readonly timingSource: HTMLElement;
  readonly timingList: HTMLElement;
}

function buildRow(className: string): RowParts {
  const time = h("time", { class: "row-time" });
  const enText = h("span", { class: "en-text" });
  const en = h("p", { class: "row-en", lang: "en" }, enText, h("span", { class: "caret", "aria-hidden": "true" }));
  const ja = h("p", { class: "row-ja", lang: "ja" });
  const tagLive = h("span", { class: "tag tag-live" }, h("span", { class: "pulse-dot", "aria-hidden": "true" }), "live");
  const tagRevising = h("span", { class: "tag tag-revising", hidden: true }, icon("retry", "icon icon-sm"), "Re-translating");
  const tagRevised = h("span", { class: "tag tag-revised", hidden: true, title: "This line was rewritten in place when the next fragment joined it." }, "revised");
  const timingSource = h("span", { class: "timing-source" });
  const timingTotal = h("span", { class: "timing-total" });
  const timingList = h("dl", { class: "timing-list" });
  const timing = h(
    "details",
    { class: "timing" },
    h("summary", { title: "Timing detail" }, timingSource, timingTotal, icon("chevron", "icon icon-sm chevron")),
    timingList,
  );
  const meta = h("div", { class: "row-meta" }, tagLive, tagRevising, tagRevised, timing);
  const el = h("article", { class: className }, time, h("div", { class: "row-body" }, en, ja, meta));
  return { el, time, en, enText, ja, tagRevising, tagRevised, timing, timingTotal, timingSource, timingList };
}

interface RowEntry {
  readonly parts: RowParts;
  row: CaptionRow;
}

export interface TranscriptOptions {
  readonly prefersReducedMotion: () => boolean;
}

/**
 * The live transcript. It patches rows in place by id and skips rows the reducer did not touch (the reducer
 * only replaces the rows an event changes), so a token costs one row's worth of DOM work. It follows the live
 * edge until the user scrolls up, then offers a way back.
 */
export class TranscriptView {
  readonly el: HTMLElement;
  /** Where the owner puts its empty state; hidden once there is anything to show. */
  readonly emptySlot: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly draft: RowParts;
  private readonly jump: HTMLButtonElement;
  private readonly alert: HTMLElement;
  private readonly announce: HTMLElement;
  private readonly entries = new Map<RowId, RowEntry>();
  private pinned = true;
  private lastScrollTop = 0;
  private seenRows = 0;
  private announced = "";

  constructor(private readonly options: TranscriptOptions) {
    this.emptySlot = h("div", { class: "empty", "data-role": "empty" });
    this.list = h("div", { class: "rows" });
    this.draft = buildRow("row draft");
    this.draft.el.hidden = true;
    this.draft.el.dataset["draft"] = "";
    this.scroller = h("div", { class: "transcript", role: "log", "aria-label": "Live captions", "aria-live": "off", tabindex: "0", "data-role": "transcript" }, this.emptySlot, this.list, this.draft.el);
    this.alert = h("div", { class: "notice notice-error", role: "alert", "data-role": "pipeline-error", hidden: true });
    this.jump = h("button", { class: "btn btn-raised jump", type: "button", "data-role": "jump", hidden: true, onclick: () => this.jumpToLive() }, icon("down"), h("span", {}, "Jump to live"));
    this.announce = h("div", { class: "sr-only", "aria-live": "polite", "data-role": "announce" });
    this.el = h("div", { class: "transcript-wrap" }, this.alert, this.scroller, this.jump, this.announce);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
  }

  jumpToLive(): void {
    this.pinned = true;
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: this.options.prefersReducedMotion() ? "auto" : "smooth" });
    this.sync(this.seenRows);
  }

  render(state: CaptionState): void {
    this.syncRows(state.rows);
    this.patchDraft(state.draft);
    const hasContent = state.rows.length > 0 || state.draft !== null;
    setHidden(this.emptySlot, hasContent);
    setText(this.alert, state.error === null ? "" : `Pipeline error: ${state.error}`);
    setHidden(this.alert, state.error === null);
    if (state.rows.length === 0) this.pinned = true;
    if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.sync(this.pinned ? state.rows.length : this.seenRows, state.rows.length);
    this.announceLatest(state.rows);
  }

  private onScroll(): void {
    const top = this.scroller.scrollTop;
    if (isNearBottom({ scrollTop: top, clientHeight: this.scroller.clientHeight, scrollHeight: this.scroller.scrollHeight })) this.pinned = true;
    else if (top < this.lastScrollTop - 1) this.pinned = false;
    this.lastScrollTop = top;
    this.sync(this.pinned ? this.entries.size : this.seenRows, this.entries.size);
  }

  /** Shows the jump control while away from the live edge, with a count of rows that arrived since. */
  private sync(seen: number, total = this.entries.size): void {
    this.seenRows = seen;
    const away = !this.pinned && total > 0;
    setHidden(this.jump, !away);
    const unseen = Math.max(0, total - seen);
    const label = this.jump.lastElementChild;
    if (label !== null) setText(label, unseen > 0 ? `Jump to live, ${unseen} new` : "Jump to live");
  }

  private syncRows(rows: readonly CaptionRow[]): void {
    const seen = new Set<RowId>();
    let cursor: Element | null = this.list.firstElementChild;
    for (const row of rows) {
      seen.add(row.id);
      let entry = this.entries.get(row.id);
      if (entry === undefined) {
        entry = { parts: buildRow("row"), row };
        entry.parts.el.dataset["rowId"] = String(row.id);
        this.paint(entry.parts, row, null);
        this.entries.set(row.id, entry);
      } else if (entry.row !== row) {
        this.paint(entry.parts, row, entry.row);
        entry.row = row;
      }
      if (entry.parts.el === cursor) cursor = cursor.nextElementSibling;
      else this.list.insertBefore(entry.parts.el, cursor);
    }
    while (cursor !== null) {
      const next: Element | null = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
    for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
  }

  private paint(parts: RowParts, row: CaptionRow, previous: CaptionRow | null): void {
    const v = rowView(row);
    setText(parts.time, v.time);
    setAttr(parts.el, "data-status", row.status);
    setAttr(parts.el, "data-provisional", String(v.provisional));
    setAttr(parts.el, "data-revising", String(v.revising));
    setAttr(parts.el, "data-revisions", String(v.revisions));
    setAttr(parts.el, "data-source", v.source);
    setText(parts.enText, v.en === "" ? v.placeholder : v.en);
    setAttr(parts.enText, "data-placeholder", v.en === "" && v.placeholder !== "" ? "true" : null);
    setAttr(parts.en, "data-provisional", String(v.enProvisional));
    setText(parts.ja, v.ja);
    setAttr(parts.ja, "data-provisional", String(v.jaProvisional));
    setHidden(parts.tagRevising, !v.revising);
    setHidden(parts.tagRevised, v.revisions === 0);
    setText(parts.tagRevised, v.revisions > 1 ? `revised ×${v.revisions}` : "revised");
    if (row.timing !== (previous?.timing ?? null) || previous === null) this.paintTiming(parts, row);
    if (previous !== null && row.revisions !== previous.revisions) this.flash(parts.el);
  }

  private paintTiming(parts: RowParts, row: CaptionRow): void {
    setHidden(parts.timing, row.timing === null);
    if (row.timing === null) return;
    setText(parts.timingSource, row.source ?? "");
    setText(parts.timingTotal, formatSeconds(row.timing.perceivedS));
    parts.timingList.replaceChildren(
      ...timingRows(row.timing, row.source).flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]),
    );
  }

  private flash(el: HTMLElement): void {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  private patchDraft(draft: Draft | null): void {
    setHidden(this.draft.el, draft === null);
    if (draft === null) return;
    const v = draftView(draft);
    setText(this.draft.time, v.time);
    setAttr(this.draft.el, "data-provisional", "true");
    setText(this.draft.enText, v.en);
    setHidden(this.draft.en, v.en === "");
    setAttr(this.draft.en, "data-provisional", "true");
    setText(this.draft.ja, v.ja);
    setAttr(this.draft.ja, "data-provisional", "true");
  }

  /** Tells screen readers about the newest settled English line, and only that: tokens would be noise. */
  private announceLatest(rows: readonly CaptionRow[]): void {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.status !== "settled" || row.en === "") continue;
      const text = `${row.id}:${row.revisions}:${row.en}`;
      if (text !== this.announced) {
        this.announced = text;
        setText(this.announce, row.en);
      }
      return;
    }
  }
}
