// Design tokens shared by the launcher (apps/launcher) and the website (apps/web).
// tokens.css holds the same values as CSS custom properties (--tm-*); keep both in step.
// Each app maps its own variable names onto these (launcher: src/styles.css, web: src/styles/global.css).
export const tokens = {
  color: {
    /** Brand orange: buttons, links, focus rings. */
    accent: '#ff6b1a',
    /** Lighter orange: hover, text on dark backgrounds. */
    accent2: '#ff8a45',
    /** Softest orange: highlights in dark UI. */
    accent3: '#ffb15e',
    /** Text on orange. */
    accentInk: '#1a0b02',
    ok: '#3ddc84',
    warn: '#f2c14e',
    bad: '#ff5d5d',
    /** Launcher window background (also Tauri's backgroundColor). */
    appBg: '#0a0c11',
    appBg2: '#10131a',
    /** Website background (dark theme). */
    siteBg: '#121418',
    siteSurface: '#1b1e24',
    text: '#eef0f3',
    text2: '#c3c9d1',
    muted: '#8e97a3',
  },
  font: {
    body: "'Inter Variable', 'Inter', 'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif",
    display: "'Barlow Condensed', 'Barlow Semi Condensed', 'Arial Narrow', sans-serif",
    mono: "'Cascadia Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
  },
  radius: { sm: '10px', md: '14px', lg: '20px' },
  /** Spacing scale (--tm-s-1 .. --tm-s-6): gaps, paddings and margins use only these steps. */
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' },
  /** Control heights (--tm-ctl-h, --tm-ctl-h-sm): buttons, selects, inputs, segmented controls. */
  control: { h: '40px', hSm: '32px' },
  /** Accent colours the user can pick: main, rgb triple, light, deep, text on light backgrounds, ink (text on the accent). */
  accents: {
    orange: { main: '#ff8a45', rgb: '255, 138, 61', light: '#ffb15e', deep: '#ff5d2b', text: '#c2410c', ink: '#1a0b02' },
    blue: { main: '#4d8dff', rgb: '77, 141, 255', light: '#9cc0ff', deep: '#2f6ae0', text: '#1d4ed8', ink: '#04122b' },
    green: { main: '#2ec27e', rgb: '46, 194, 126', light: '#86e8b5', deep: '#1c9a5a', text: '#15803d', ink: '#03200f' },
    purple: { main: '#9d6bff', rgb: '157, 107, 255', light: '#c9b0ff', deep: '#7444e8', text: '#6d28d9', ink: '#14062e' },
    red: { main: '#ff5468', rgb: '255, 84, 104', light: '#ff9aa6', deep: '#d92b41', text: '#be123c', ink: '#2a0408' },
    teal: { main: '#22c1b0', rgb: '34, 193, 176', light: '#7fe6da', deep: '#129484', text: '#0f766e', ink: '#021f1c' },
  },
} as const;

export type Tokens = typeof tokens;
