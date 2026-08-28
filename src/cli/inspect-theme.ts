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
