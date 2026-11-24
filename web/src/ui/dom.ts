export type Child = Node | string | null | false | undefined;

type Prop = string | number | boolean | EventListener | undefined;

/**
 * Builds an element. Props: `class`, `on<event>` listeners, boolean attributes (true sets, false skips)
 * and plain attributes, including `data-*`. Children that are null, undefined or false are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Readonly<Record<string, Prop>> = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(name.slice(2), value);
    else if (name === "class") el.className = String(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    parent.append(child);
  }
}

/** Writes text only when it differs, so a render pass that changes nothing touches nothing. */
export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Sets an attribute, or removes it for null, only when the value differs. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** Replaces a node's children when `render` produces a different set; used for small, rarely changing lists. */
export function replaceChildren(parent: Element, children: readonly Node[]): void {
  parent.replaceChildren(...children);
}
