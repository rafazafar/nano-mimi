import type { PairId } from "../core/pair";
import { formatBytes } from "../models/types";
import type { CaptionState } from "../pipeline";
import { h, setAttr, setHidden, setText } from "./dom";
import { formatMs, formatTimestamp } from "./format";
import type { FloatingState } from "./floating";
import type { Messages, RichText } from "./i18n";
import { icon, type IconName } from "./icons";
import { pipUnavailableText } from "./pip";
import type { SourceChoice, SourceKind } from "./source";
import type { AppState } from "./state";
import { TranscriptView } from "./transcript";

export interface LiveCallbacks {
  onChooseSource(kind: SourceKind): void;
  onPickFile(file: File): void;
  onStart(): void;
  onStop(): void;
  onToggleFloating(): void;
}

type LiveState = Extract<AppState, { kind: "ready" | "starting" | "running" | "stopping" }>;

export const isLiveState = (state: AppState): state is LiveState =>
  state.kind === "ready" || state.kind === "starting" || state.kind === "running" || state.kind === "stopping";

export interface LiveModel {
  readonly state: LiveState;
  readonly captions: CaptionState;
  readonly floating: FloatingState;
  readonly pair: PairId;
  readonly elapsedS: number;
}

const SOURCES: readonly { readonly kind: SourceKind; readonly icon: IconName }[] = [
  { kind: "mic", icon: "mic" },
  { kind: "tab", icon: "tab" },
  { kind: "file", icon: "wave" },
];

export class LiveView {
  readonly el: HTMLElement;
  readonly transcript: TranscriptView;
  private readonly sourceLine: HTMLElement;
  private readonly pipButton: HTMLButtonElement;
  private readonly pipLabel: HTMLElement;
  private readonly pipNote: HTMLElement;
  private readonly radios = new Map<SourceKind, HTMLInputElement>();
  private readonly detail: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly fileButton: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly sourceError: HTMLElement;
  private readonly action: HTMLButtonElement;
  private readonly actionIcon: HTMLElement;
  private readonly actionLabel: HTMLElement;
  private readonly emptyTitle: HTMLElement;
  private readonly emptyBody: HTMLElement;
  private readonly emptyMeta: HTMLElement;
  private readonly emptyListening: HTMLElement;
  private readonly drop: HTMLElement;
  private readonly fileLabel: HTMLElement;
  private pendingAction: "start" | "stop" | "none" = "none";
  private kind: SourceKind = "mic";
  private readonly shareGuide: HTMLDialogElement;

  constructor(
    private readonly m: Messages,
    private readonly callbacks: LiveCallbacks,
    reducedMotion: () => boolean,
  ) {
    this.transcript = new TranscriptView({ messages: m, prefersReducedMotion: reducedMotion });

    this.emptyTitle = h("p", { class: "empty-title" });
    this.emptyBody = h("p", { class: "empty-body" });
    this.emptyMeta = h("p", { class: "empty-meta" });
    this.emptyListening = h("span", { class: "listening", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i"));
    this.transcript.emptySlot.append(this.emptyListening, this.emptyTitle, this.emptyBody, this.emptyMeta);

    this.sourceLine = h("span", { class: "live-source", "data-role": "live-source" });
    this.pipLabel = h("span", {});
    this.pipButton = h("button", { class: "btn", type: "button", "data-role": "pip", onclick: () => this.callbacks.onToggleFloating() }, icon("pip"), this.pipLabel);
    this.pipNote = h("p", { class: "note pip-note", id: "pip-note", "data-role": "pip-note", hidden: true });
    this.pipButton.setAttribute("aria-describedby", "pip-note");

    const toolbar = h("div", { class: "live-toolbar" }, h("div", { class: "live-title" }, h("h1", {}, m.live.title), this.sourceLine), this.pipButton);

    this.fileInput = h("input", { type: "file", accept: ".wav,audio/wav,audio/x-wav,audio/wave", hidden: true, "data-role": "file-input", onchange: () => this.onFileInput() });
    this.fileLabel = h("span", {}, m.source.chooseWav);
    this.fileButton = h("button", { class: "btn", type: "button", "data-role": "choose-file", onclick: () => this.fileInput.click() }, icon("upload"), this.fileLabel);
    this.hint = h("span", { class: "hint", "data-role": "source-hint" });
    this.detail = h("div", { class: "dock-detail" }, this.hint, this.fileButton, this.fileInput);

    const group = h("fieldset", { class: "segmented", "data-role": "source" }, h("legend", { class: "sr-only" }, m.source.legend));
    for (const source of SOURCES) {
      const input = h("input", { type: "radio", name: "source", value: source.kind, "data-source": source.kind, onchange: () => this.callbacks.onChooseSource(source.kind) });
      this.radios.set(source.kind, input);
      group.append(h("label", { class: "seg" }, input, h("span", { class: "seg-face" }, icon(source.icon), m.source.label[source.kind])));
    }

    this.actionIcon = h("span", { class: "btn-icon-slot" });
    this.actionLabel = h("span", {});
    this.action = h("button", { class: "btn btn-primary btn-lg", type: "button", "data-role": "start", onclick: () => this.onAction() }, this.actionIcon, this.actionLabel);
    this.sourceError = h("p", { class: "notice notice-error", role: "alert", "data-role": "source-error", hidden: true });
    this.drop = h("div", { class: "drop", "data-role": "drop", hidden: true }, icon("upload"), h("p", {}, m.source.dropHint));

    this.shareGuide = shareGuideDialog(m, () => this.callbacks.onStart());

    this.el = h(
      "section",
      { class: "live", "data-role": "live" },
      this.shareGuide,
      toolbar,
      this.pipNote,
      this.transcript.el,
      this.sourceError,
      h("div", { class: "dock" }, group, this.detail, this.action),
      this.drop,
    );
  }

  setDropTarget(active: boolean): void {
    setHidden(this.drop, !active);
  }

  private onAction(): void {
    // The share dialog Chrome opens is easy to get wrong, so tab capture opens with a short guide.
    if (this.pendingAction === "start" && this.kind === "tab") this.shareGuide.showModal();
    else if (this.pendingAction === "start") this.callbacks.onStart();
    else if (this.pendingAction === "stop") this.callbacks.onStop();
  }

  private onFileInput(): void {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (file !== undefined) this.callbacks.onPickFile(file);
  }

  update(model: LiveModel): void {
    const { state, captions } = model;
    const kind = state.source.kind;
    this.kind = kind;
    const idle = state.kind === "ready";
    this.transcript.render(captions, model.pair);
    setText(this.sourceLine, this.describeSource(state, model.elapsedS));
    this.paintFloating(model.floating);
    this.paintEmpty(state, model.pair);
    this.paintDock(state, idle, kind);
  }

  private describeSource(state: LiveState, elapsedS: number): string {
    const label = this.m.source.label[state.source.kind];
    if (state.kind === "running" || state.kind === "stopping") return this.m.live.sourceRunning(label, formatTimestamp(elapsedS));
    if (state.source.kind === "file" && state.source.pick !== null) return state.source.pick.name;
    return label;
  }

  private paintFloating(floating: FloatingState): void {
    const open = floating.kind === "open";
    this.pipButton.disabled = floating.kind === "unavailable" || floating.kind === "opening";
    setAttr(this.pipButton, "aria-pressed", floating.kind === "unavailable" ? null : String(open));
    setAttr(this.pipButton, "data-pip", floating.kind);
    setText(this.pipLabel, open ? this.m.live.floatingClose : floating.kind === "opening" ? this.m.live.floatingOpening : this.m.live.floatingOpen);
    const note = floating.kind === "unavailable" ? pipUnavailableText(floating.reason, this.m) : floating.kind === "closed" ? (floating.error ?? "") : "";
    setText(this.pipNote, note);
    setHidden(this.pipNote, note === "");
    setAttr(this.pipNote, "data-tone", floating.kind === "closed" ? "error" : null);
  }

  private paintEmpty(state: LiveState, pair: PairId): void {
    const text = this.m.live;
    const kind = state.source.kind;
    const listening = state.kind === "running";
    setAttr(this.transcript.emptySlot, "data-state", state.kind);
    setHidden(this.emptyListening, !listening);
    if (state.kind === "ready") {
      setText(this.emptyTitle, text.readyTitle);
      setText(this.emptyBody, text.emptyCopy[pair][kind]);
      setText(this.emptyMeta, text.modelsLoadedIn(formatMs(state.loadMs, this.m.units)));
    } else if (state.kind === "starting") {
      setText(this.emptyTitle, text.waitingTitle);
      setText(this.emptyBody, text.waitingBody[kind]);
      setText(this.emptyMeta, "");
    } else if (state.kind === "running") {
      setText(this.emptyTitle, text.listeningTitle);
      setText(this.emptyBody, text.listeningBody);
      setText(this.emptyMeta, "");
    } else {
      setText(this.emptyTitle, text.finishingTitle);
      setText(this.emptyBody, text.finishingBody);
      setText(this.emptyMeta, "");
    }
  }

  private paintDock(state: LiveState, idle: boolean, kind: SourceKind): void {
    for (const [k, input] of this.radios) {
      input.checked = k === kind;
      input.disabled = !idle;
    }
    setText(this.hint, this.hintFor(state.source));
    setHidden(this.fileButton, kind !== "file");
    this.fileButton.disabled = !idle;
    setText(this.fileLabel, state.source.kind === "file" && state.source.pick !== null ? this.m.source.chooseAnother : this.m.source.chooseWav);
    const err = state.kind === "ready" ? state.sourceError : null;
    setText(this.sourceError, err ?? "");
    setHidden(this.sourceError, err === null);

    const mode = state.kind === "ready" ? "start" : state.kind === "running" ? "stop" : "none";
    this.pendingAction = mode;
    this.action.classList.toggle("btn-primary", mode !== "stop");
    this.action.classList.toggle("btn-stop", mode === "stop");
    this.action.disabled = mode === "none" || (mode === "start" && state.source.kind === "file" && state.source.pick === null);
    setAttr(this.action, "aria-busy", state.kind === "starting" || state.kind === "stopping" ? "true" : null);
    setAttr(this.action, "data-mode", mode === "none" ? state.kind : mode);
    this.actionIcon.replaceChildren(
      state.kind === "starting" || state.kind === "stopping" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(mode === "stop" ? "stop" : "play"),
    );
    const text = this.m.live;
    setText(this.actionLabel, state.kind === "starting" ? text.starting : state.kind === "stopping" ? text.finishing : mode === "stop" ? text.stop : text.start);
  }

  private hintFor(source: SourceChoice): string {
    const { hint, fileHint } = this.m.source;
    if (source.kind !== "file") return hint[source.kind];
    return source.pick === null ? hint.file : fileHint(source.pick.name, formatBytes(source.pick.bytes.length), Math.round(source.pick.sampleRate / 100) / 10);
  }
}

const rich = (text: RichText): (Node | string)[] => text.map((part) => (typeof part === "string" ? part : h("b", {}, part.strong)));

function shareGuideDialog(m: Messages, onContinue: () => void): HTMLDialogElement {
  const guide = m.live.shareGuide;
  const dialog: HTMLDialogElement = h(
    "dialog",
    { class: "share-guide", "data-role": "share-guide", "aria-labelledby": "share-guide-title" },
    h("h2", { id: "share-guide-title" }, guide.title),
    h("p", {}, guide.intro),
    h("ol", {}, ...guide.steps.map((step) => h("li", {}, ...rich(step)))),
    h(
      "div",
      { class: "share-guide-actions" },
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, guide.cancel),
      h("button", { class: "btn btn-primary", type: "button", "data-role": "share-continue", onclick: () => { dialog.close(); onContinue(); } }, guide.continue),
    ),
  );
  return dialog;
}
