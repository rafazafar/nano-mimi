import type { Health } from "../pipeline";
import { h, setAttr, setHidden, setText } from "./dom";
import { formatBehind } from "./format";
import { icon } from "./icons";
import type { StatusTone } from "./state";
import type { Theme } from "./theme";

export interface HeaderModel {
  readonly status: { readonly tone: StatusTone; readonly label: string };
  readonly health: Health;
  readonly backlogS: number;
  /** The theme the page shows now, so the button offers the other one. */
  readonly theme: Theme;
}

function brandMark(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("class", "brand-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<rect x="1.5" y="3.5" width="25" height="18" rx="5" class="mark-bubble"/><path d="M8 21.5l-2.5 4.25 6.5-4.25z" class="mark-bubble"/><path d="M7.5 10.5h8M7.5 14.5h13" class="mark-lines"/>';
  return svg;
}

/** The bar across the top: who we are, where the app is, whether captions are keeping up, and the theme. */
export class HeaderView {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthIcon: HTMLElement;
  private readonly healthLabel: HTMLElement;
  private readonly themeButton: HTMLButtonElement;
  private readonly themeIcon: HTMLElement;
  private shownTheme: Theme | null = null;

  constructor(onToggleTheme: () => void) {
    this.statusLabel = h("span", { "data-role": "status-label" });
    this.status = h("span", { class: "status", "data-role": "status" }, h("span", { class: "status-dot", "aria-hidden": "true" }), this.statusLabel);
    this.healthIcon = h("span", { class: "health-icon" });
    this.healthLabel = h("span", { "data-role": "health-label" });
    this.health = h("span", { class: "health", role: "status", "data-role": "health", hidden: true }, this.healthIcon, this.healthLabel);
    this.themeIcon = h("span", { class: "btn-icon-slot" });
    this.themeButton = h("button", { class: "btn btn-quiet btn-icon", type: "button", "data-role": "theme", onclick: onToggleTheme }, this.themeIcon);
    this.el = h(
      "header",
      { class: "topbar" },
      h("div", { class: "brand" }, brandMark(), h("span", { class: "brand-name" }, "MimiVox"), h("span", { class: "brand-pair", title: "Japanese to English" }, "JA → EN")),
      this.status,
      this.health,
      h("span", { class: "spacer" }),
      this.themeButton,
    );
  }

  update(model: HeaderModel): void {
    setAttr(this.status, "data-tone", model.status.tone);
    setText(this.statusLabel, model.status.label);

    const behind = model.health !== "ok";
    setHidden(this.health, !behind);
    setAttr(this.health, "data-health", behind ? model.health : null);
    if (behind) {
      setText(this.healthLabel, formatBehind(model.backlogS, model.health === "overloaded" ? "overloaded" : "behind"));
      const wanted = model.health === "overloaded" ? "alert" : "clock";
      if (this.healthIcon.dataset["icon"] !== wanted) {
        this.healthIcon.dataset["icon"] = wanted;
        this.healthIcon.replaceChildren(icon(wanted));
      }
    }

    if (this.shownTheme !== model.theme) {
      this.shownTheme = model.theme;
      this.themeIcon.replaceChildren(icon(model.theme === "dark" ? "sun" : "moon"));
      const label = model.theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
      setAttr(this.themeButton, "aria-label", label);
      setAttr(this.themeButton, "title", label);
    }
  }
}
