import { PAIR_IDS, type PairId } from "../core/pair";
import { h, setAttr, setHidden } from "./dom";
import type { Messages } from "./i18n";
import { icon } from "./icons";
import { sourceLang, targetLang } from "./pairLang";

/** Why the direction cannot change right now: a session is running, or a download or load is in progress. */
export type PairLock = "live" | "busy" | null;

/** The pill's text: `JA → EN`. Language codes read the same in every UI language. */
export const pairCode = (pair: PairId): string => `${sourceLang(pair).toUpperCase()} → ${targetLang(pair).toUpperCase()}`;

/**
 * A pill showing the current direction that opens a small menu of both. It follows the menu button pattern:
 * the button has `aria-haspopup="menu"`, the items are `menuitemradio`, arrows move between them, Escape and
 * a click outside close the menu, and focus goes back to the button.
 */
export class PairSwitcher {
  readonly el: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly code: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly items = new Map<PairId, HTMLButtonElement>();
  private current: PairId = "ja-en";
  private open = false;
  /** `aria-disabled`, not `disabled`, so the button keeps focus while a switch reloads the app. */
  private locked = false;

  constructor(
    private readonly m: Messages,
    private readonly onChoose: (pair: PairId) => void,
  ) {
    this.code = h("span", { class: "pair-code" });
    this.trigger = h(
      "button",
      {
        class: "pair-trigger",
        type: "button",
        "data-role": "pair",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": "pair-menu",
        onclick: () => this.toggle(),
        onkeydown: (e: Event) => this.onTriggerKey(e as KeyboardEvent),
      },
      this.code,
      icon("chevron", "icon icon-sm pair-chevron"),
    );
    this.menu = h("div", { class: "pair-menu", id: "pair-menu", role: "menu", "aria-label": m.pair.menuLabel, "data-role": "pair-menu", hidden: true, onkeydown: (e: Event) => this.onMenuKey(e as KeyboardEvent) });
    for (const pair of PAIR_IDS) {
      const text = m.pair.options[pair];
      const item = h(
        "button",
        { class: "pair-item", type: "button", role: "menuitemradio", "aria-checked": "false", tabindex: "-1", "data-pair": pair, onclick: () => this.choose(pair) },
        h("span", { class: "pair-item-body" }, h("span", { class: "pair-item-title" }, text.title), h("span", { class: "pair-item-hint" }, text.hint)),
        icon("check", "icon pair-check"),
      );
      this.items.set(pair, item);
      this.menu.append(item);
    }
    this.el = h("div", { class: "pair-switch" }, this.trigger, this.menu);
    document.addEventListener("pointerdown", this.onOutside, true);
  }

  update(pair: PairId, lock: PairLock): void {
    this.current = pair;
    this.code.textContent = pairCode(pair);
    setAttr(this.trigger, "aria-label", this.m.pair.triggerLabel(pairCode(pair)));
    const reason = lock === "live" ? this.m.pair.disabledLive : lock === "busy" ? this.m.pair.disabledBusy : null;
    this.locked = lock !== null;
    setAttr(this.trigger, "aria-disabled", this.locked ? "true" : null);
    setAttr(this.trigger, "title", reason ?? this.m.pair.menuLabel);
    if (lock !== null && this.open) this.close(false);
    for (const [id, item] of this.items) setAttr(item, "aria-checked", String(id === pair));
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.onOutside, true);
  }

  private readonly onOutside = (event: Event): void => {
    if (this.open && event.target instanceof Node && !this.el.contains(event.target)) this.close(false);
  };

  private toggle(): void {
    if (this.open) this.close(true);
    else this.show(this.current);
  }

  private show(focus: PairId | "last"): void {
    if (this.locked) return;
    this.open = true;
    setHidden(this.menu, false);
    setAttr(this.trigger, "aria-expanded", "true");
    const list = [...this.items.values()];
    (focus === "last" ? list[list.length - 1] : this.items.get(focus))?.focus();
  }

  private close(refocus: boolean): void {
    if (!this.open) return;
    this.open = false;
    setHidden(this.menu, true);
    setAttr(this.trigger, "aria-expanded", "false");
    if (refocus) this.trigger.focus();
  }

  private choose(pair: PairId): void {
    this.close(true);
    if (pair !== this.current) this.onChoose(pair);
  }

  private onTriggerKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") this.show(this.current);
    else if (event.key === "ArrowUp") this.show("last");
    else return;
    event.preventDefault();
  }

  private onMenuKey(event: KeyboardEvent): void {
    const list = [...this.items.values()];
    const at = list.findIndex((item) => item === document.activeElement);
    const move = (to: number): void => {
      list[(to + list.length) % list.length]?.focus();
      event.preventDefault();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return this.close(true);
      case "Tab":
        return this.close(false);
    }
  }
}
