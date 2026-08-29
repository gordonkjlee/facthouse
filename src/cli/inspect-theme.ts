/**
 * Ledger colours for inspect and spend HTML. This is the live product
 * definition; brand-dev/colour/tokens.json is the workshop copy.
 */

export const LEDGER = {
  dark: {
    bg: "#10130f",
    panel: "#181c16",
    text: "#e8e4d8",
    muted: "#9a9486",
    line: "#2a3126",
    gold: "#c4a35a",
    warn: "#d08b6a",
    mark: "#1e261c",
    shell: "#556344",
  },
  light: {
    bg: "#f3efe4",
    panel: "#fffaf0",
    text: "#1a1c16",
    muted: "#6b665c",
    line: "#d4cfc2",
    gold: "#8a6420",
    warn: "#a85a3a",
    mark: "#1e261c",
    shell: "#556344",
  },
  stage: {
    extract: "#c4a35a",
    classify: "#6aa8c9",
    entities: "#7eb889",
    reconcile: "#d08b6a",
    supersede: "#c97b9a",
    summarise: "#9b8fd4",
  },
} as const;

type Palette = (typeof LEDGER)["dark"] | (typeof LEDGER)["light"];

function vars(
  p: Palette,
  extras: { elev: string; glow: string; label: string; labelText: string },
): string {
  return [
    `--bg: ${p.bg}`,
    `--panel: ${p.panel}`,
    `--card: ${p.panel}`,
    `--line: ${p.line}`,
    `--text: ${p.text}`,
    `--ink: ${p.text}`,
    `--muted: ${p.muted}`,
    `--accent: ${p.gold}`,
    `--gold: ${p.gold}`,
    `--warn: ${p.warn}`,
    `--about: ${LEDGER.stage.entities}`,
    `--mention: ${p.gold}`,
    `--elev: ${extras.elev}`,
    `--input: ${p.bg}`,
    `--chip: ${p.line}`,
    `--glow: ${extras.glow}`,
    `--canvas-label: ${extras.label}`,
    `--canvas-label-text: ${extras.labelText}`,
  ].join("; ");
}

/** CSS custom properties for inspect (dark default, light override). */
export function ledgerInspectCss(): string {
  const d = LEDGER.dark;
  const l = LEDGER.light;
  const dark = vars(d, {
    elev: d.mark,
    glow: d.mark,
    label: "rgba(16,19,15,0.78)",
    labelText: d.text,
  });
  const light = vars(l, {
    elev: l.bg,
    glow: "#e8e0c8",
    label: "rgba(255,250,240,0.88)",
    labelText: l.text,
  });
  return `
  :root {
    color-scheme: dark;
    ${dark};
  }
  html[data-theme="light"] {
    color-scheme: light;
    ${light};
  }
  @media (prefers-color-scheme: light) {
    html[data-theme="system"] {
      color-scheme: light;
      ${light};
    }
  }`;
}

/** Geometric mark: olive tile, gold glasses, a small cap. Favicon-simple. */
export const LEDGER_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">' +
  '<rect width="32" height="32" rx="7" fill="#1e261c"/>' +
  '<path fill="#556344" d="M10 12c0-3.2 2.6-5.2 6-5.2s6 2 6 5.2c0 1.3-1.2 2.2-3.1 2.4H13.1C11.2 14.2 10 13.3 10 12z"/>' +
  '<circle cx="11.6" cy="19.4" r="4.3" fill="#556344" stroke="#c4a35a" stroke-width="1.6"/>' +
  '<circle cx="20.4" cy="19.4" r="4.3" fill="#556344" stroke="#c4a35a" stroke-width="1.6"/>' +
  '<path d="M15.9 19.4h.2" stroke="#c4a35a" stroke-width="1.5" stroke-linecap="round"/>' +
  '<circle cx="11.6" cy="19.4" r="1.45" fill="#c4a35a"/>' +
  '<circle cx="20.4" cy="19.4" r="1.45" fill="#c4a35a"/>' +
  "</svg>";

export function ledgerFaviconHref(): string {
  return "data:image/svg+xml," + encodeURIComponent(LEDGER_MARK_SVG);
}

/** CSS custom properties for the standalone spend HTML (dark only). */
export function ledgerSpendCss(): string {
  const d = LEDGER.dark;
  return `
  :root {
    color-scheme: dark;
    ${vars(d, {
      elev: d.mark,
      glow: d.mark,
      label: "rgba(16,19,15,0.78)",
      labelText: d.text,
    })};
  }`;
}
