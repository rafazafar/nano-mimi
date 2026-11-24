import type { EnText, JaText } from "../core/types";
import type { EnSource, Health, PipelineEvent, RowId, Timing } from "./types";

/** A continuation being re-translated into its target row. `ja` is the joined line. */
export interface Revising {
  readonly ja: JaText;
  readonly streamed: string;
}

/**
 * One caption row. `status` is the row's whole lifecycle: it is `translating` from the ASR final until the
 * English lands, then `settled`. `streamed` is provisional text; `en` is only ever the settled translation.
 */
export interface CaptionRow {
  readonly id: RowId;
  readonly status: "translating" | "settled";
  readonly timelineS: number;
  readonly durationS: number;
  readonly ja: JaText;
  readonly en: EnText | "";
  /** English as the translator streams it; meaningful while `status` is `translating`. */
  readonly streamed: string;
  /** Ids of the later fragments folded into this row. */
  readonly mergedIds: readonly RowId[];
  /** How many times the row was rewritten in place; the UI flashes it when this changes. */
  readonly revisions: number;
  readonly revising: Revising | null;
  readonly source: EnSource | null;
  readonly timing: Timing | null;
}

/** The line being spoken before ASR finishes it: decoded JA and its preview, both provisional. */
export interface Draft {
  readonly ja: JaText;
  readonly timelineS: number;
  readonly previewEn: EnText | "";
  readonly previewVersion: number;
  readonly previewComplete: boolean;
}

export interface CaptionState {
  readonly rows: readonly CaptionRow[];
  readonly draft: Draft | null;
  readonly health: Health;
  readonly backlogS: number;
  /** The latest error since the last settled row, or null. */
  readonly error: string | null;
}

export const emptyCaptions: CaptionState = { rows: [], draft: null, health: "ok", backlogS: 0, error: null };

function update(rows: readonly CaptionRow[], id: RowId, change: (row: CaptionRow) => CaptionRow): readonly CaptionRow[] {
  return rows.map((row) => (row.id === id ? change(row) : row));
}

/**
 * The screen as a function of the event log. Pure, so the live view, the floating window and the tests all
 * derive from the same events and cannot disagree.
 */
export function reduceCaptions(state: CaptionState, event: PipelineEvent): CaptionState {
  switch (event.kind) {
    case "partial_ja":
      return { ...state, draft: { ja: event.ja, timelineS: event.timelineS, previewEn: state.draft?.previewEn ?? "", previewVersion: state.draft?.previewVersion ?? 0, previewComplete: state.draft?.previewComplete ?? false } };
    case "partial_en":
      if (state.draft === null || event.version < state.draft.previewVersion) return state;
      return { ...state, draft: { ...state.draft, previewEn: event.en, previewVersion: event.version, previewComplete: event.complete } };
    case "translating":
      return {
        ...state,
        draft: null,
        rows: [
          ...state.rows,
          {
            id: event.id,
            status: "translating",
            timelineS: event.timelineS,
            durationS: 0,
            ja: event.ja,
            en: "",
            streamed: "",
            mergedIds: [],
            revisions: 0,
            revising: null,
            source: null,
            timing: null,
          },
        ],
      };
    case "revising":
      return { ...state, draft: null, rows: update(state.rows, event.targetId, (row) => ({ ...row, revising: { ja: event.ja, streamed: "" } })) };
    case "revision_failed":
      return { ...state, rows: update(state.rows, event.targetId, (row) => ({ ...row, revising: null })) };
    case "en_token":
      return {
        ...state,
        rows: update(state.rows, event.id, (row) =>
          row.revising === null
            ? { ...row, streamed: row.streamed + event.delta }
            : { ...row, revising: { ...row.revising, streamed: row.revising.streamed + event.delta } },
        ),
      };
    case "final":
      return {
        ...state,
        error: null,
        rows: update(state.rows, event.id, (row) => ({
          ...row,
          status: "settled",
          durationS: event.durationS,
          timelineS: event.timelineS,
          ja: event.ja,
          en: event.en,
          streamed: "",
          source: event.source,
          timing: event.timing,
        })),
      };
    case "revision":
      return {
        ...state,
        error: null,
        rows: update(state.rows, event.targetId, (row) => ({
          ...row,
          status: "settled",
          timelineS: event.timelineS,
          durationS: event.durationS,
          ja: event.ja,
          en: event.en,
          streamed: "",
          mergedIds: event.mergedIds,
          revisions: row.revisions + 1,
          revising: null,
          source: event.source,
          timing: event.timing,
        })),
      };
    case "backlog":
      return { ...state, health: event.health, backlogS: event.backlogS };
    case "error":
      return { ...state, error: event.detail };
  }
}
