import { formatBytes } from "../models/types";
import type { CaptionState } from "../pipeline";
import { h, setAttr, setHidden, setText } from "./dom";
import { formatMs, formatTimestamp } from "./format";
import type { FloatingState } from "./floating";
import { icon, type IconName } from "./icons";
import { SOURCE_LABEL, type SourceChoice, type SourceKind } from "./source";
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
  readonly elapsedS: number;
}

const SOURCES: readonly { readonly kind: SourceKind; readonly icon: IconName }[] = [
  { kind: "mic", icon: "mic" },
  { kind: "tab", icon: "tab" },
  { kind: "file", icon: "wave" },
];

const SOURCE_HINT: Readonly<Record<SourceKind, string>> = {
  mic: "Uses your default microphone. The browser asks for permission the first time.",
  tab: "A tab, or the entire screen for all sound.",
  file: "Replays a recording at normal speed through the same path as live audio. 16-bit PCM or 32-bit float WAV.",
};

const EMPTY_COPY: Readonly<Record<SourceKind, string>> = {
  mic: "Press Start and speak Japanese. English appears under each line a moment after you finish it.",
  tab: "Press Start, choose the tab with the call or video (or your entire screen), and share its audio. English appears under each line as it is spoken.",
  file: "Choose or drop a WAV recording, then press Start. It plays at normal speed and the captions follow it.",
};

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

  constructor(private readonly callbacks: LiveCallbacks, reducedMotion: () => boolean) {
    this.transcript = new TranscriptView({ prefersReducedMotion: reducedMotion });

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

    const toolbar = h("div", { class: "live-toolbar" }, h("div", { class: "live-title" }, h("h1", {}, "Captions"), this.sourceLine), this.pipButton);

    this.fileInput = h("input", { type: "file", accept: ".wav,audio/wav,audio/x-wav,audio/wave", hidden: true, "data-role": "file-input", onchange: () => this.onFileInput() });
    this.fileLabel = h("span", {}, "Choose WAV");
    this.fileButton = h("button", { class: "btn", type: "button", "data-role": "choose-file", onclick: () => this.fileInput.click() }, icon("upload"), this.fileLabel);
    this.hint = h("span", { class: "hint", "data-role": "source-hint" });
    this.detail = h("div", { class: "dock-detail" }, this.hint, this.fileButton, this.fileInput);

    const group = h("fieldset", { class: "segmented", "data-role": "source" }, h("legend", { class: "sr-only" }, "Audio source"));
    for (const source of SOURCES) {
      const input = h("input", { type: "radio", name: "source", value: source.kind, "data-source": source.kind, onchange: () => this.callbacks.onChooseSource(source.kind) });
      this.radios.set(source.kind, input);
      group.append(h("label", { class: "seg" }, input, h("span", { class: "seg-face" }, icon(source.icon), SOURCE_LABEL[source.kind])));
    }

    this.actionIcon = h("span", { class: "btn-icon-slot" });
    this.actionLabel = h("span", {});
    this.action = h("button", { class: "btn btn-primary btn-lg", type: "button", "data-role": "start", onclick: () => this.onAction() }, this.actionIcon, this.actionLabel);
    this.sourceError = h("p", { class: "notice notice-error", role: "alert", "data-role": "source-error", hidden: true });
    this.drop = h("div", { class: "drop", "data-role": "drop", hidden: true }, icon("upload"), h("p", {}, "Drop a WAV file to replay it"));

    this.shareGuide = shareGuideDialog(() => this.callbacks.onStart());

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
    this.transcript.render(captions);
    setText(this.sourceLine, this.describeSource(state, model.elapsedS));
    this.paintFloating(model.floating);
    this.paintEmpty(state);
    this.paintDock(state, idle, kind);
  }

  private describeSource(state: LiveState, elapsedS: number): string {
    const label = SOURCE_LABEL[state.source.kind];
    if (state.kind === "running" || state.kind === "stopping") return `${label}, ${formatTimestamp(elapsedS)}`;
    if (state.source.kind === "file" && state.source.pick !== null) return state.source.pick.name;
    return label;
  }

  private paintFloating(floating: FloatingState): void {
    const open = floating.kind === "open";
    this.pipButton.disabled = floating.kind === "unavailable" || floating.kind === "opening";
    setAttr(this.pipButton, "aria-pressed", floating.kind === "unavailable" ? null : String(open));
    setAttr(this.pipButton, "data-pip", floating.kind);
    setText(this.pipLabel, open ? "Close floating captions" : floating.kind === "opening" ? "Opening" : "Floating captions");
    const note = floating.kind === "unavailable" ? floating.reason : floating.kind === "closed" ? (floating.error ?? "") : "";
    setText(this.pipNote, note);
    setHidden(this.pipNote, note === "");
    setAttr(this.pipNote, "data-tone", floating.kind === "closed" ? "error" : null);
  }

  private paintEmpty(state: LiveState): void {
    const kind = state.source.kind;
    const listening = state.kind === "running";
    setAttr(this.transcript.emptySlot, "data-state", state.kind);
    setHidden(this.emptyListening, !listening);
    if (state.kind === "ready") {
      setText(this.emptyTitle, "Ready");
      setText(this.emptyBody, EMPTY_COPY[kind]);
      setText(this.emptyMeta, `Models loaded in ${formatMs(state.loadMs)}.`);
    } else if (state.kind === "starting") {
      setText(this.emptyTitle, "Waiting for access");
      setText(this.emptyBody, kind === "tab" ? "Choose a tab in the share dialog." : kind === "mic" ? "Allow microphone access in the browser prompt." : "Reading the file.");
      setText(this.emptyMeta, "");
    } else if (state.kind === "running") {
      setText(this.emptyTitle, "Listening");
      setText(this.emptyBody, "Captions appear a moment after each phrase ends.");
      setText(this.emptyMeta, "");
    } else {
      setText(this.emptyTitle, "Finishing");
      setText(this.emptyBody, "Speech already heard is still being translated.");
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
    setText(this.fileLabel, state.source.kind === "file" && state.source.pick !== null ? "Choose another" : "Choose WAV");
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
    setText(this.actionLabel, state.kind === "starting" ? "Starting" : state.kind === "stopping" ? "Finishing" : mode === "stop" ? "Stop" : "Start captions");
  }

  private hintFor(source: SourceChoice): string {
    if (source.kind !== "file") return SOURCE_HINT[source.kind];
    return source.pick === null ? SOURCE_HINT.file : `${source.pick.name}, ${formatBytes(source.pick.bytes.length)}, ${Math.round(source.pick.sampleRate / 100) / 10} kHz. Plays at normal speed.`;
  }
}

function shareGuideDialog(onContinue: () => void): HTMLDialogElement {
  const dialog: HTMLDialogElement = h(
    "dialog",
    { class: "share-guide", "data-role": "share-guide", "aria-labelledby": "share-guide-title" },
    h("h2", { id: "share-guide-title" }, "Share audio"),
    h("p", {}, "Chrome will ask what to share next."),
    h(
      "ol",
      {},
      h("li", {}, "Pick the tab with the call or video. For sound from other apps, pick ", h("b", {}, "Entire screen"), "."),
      h("li", {}, "Turn on ", h("b", {}, "Share tab audio"), " (or ", h("b", {}, "Share system audio"), ")."),
      h("li", {}, "Click ", h("b", {}, "Share"), "."),
    ),
    h(
      "div",
      { class: "share-guide-actions" },
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
      h("button", { class: "btn btn-primary", type: "button", "data-role": "share-continue", onclick: () => { dialog.close(); onContinue(); } }, "Continue"),
    ),
  );
  return dialog;
}
