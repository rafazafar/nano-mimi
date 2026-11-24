const PATHS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  tab: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9.5h18M7 7.25h.01"/>',
  wave: '<path d="M4 10v4M8 6.5v11M12 3.5v17M16 8v8M20 10.5v3"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="11.5" y="11" width="7" height="5" rx="1.25"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1"/>',
  moon: '<path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4.5l9 15.5H3z"/><path d="M12 10.5v4M12 17.25h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<path d="M8.5 6v12M15.5 6v12"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.25M12 7.75h.01"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19.5h14"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = PATHS[name];
  return svg;
}
