// When the launcher looks for, downloads and installs its own updates (ui/Updater.tsx). Pure functions, tested in
// updateRules.test.ts; the Rust side (src-tauri/src/updater.rs may_install) has the same install rule and also
// refuses while a game runs.

/** While the launcher stays open it looks again every six hours. */
export const CHECK_EVERY_MS = 6 * 3600 * 1000;
/** First look after start: a few seconds, so the start itself stays quick. */
export const FIRST_CHECK_MS = 6000;

export function checkDue(lastCheck: number | null, now: number): boolean {
  return lastCheck === null || now - lastCheck >= CHECK_EVERY_MS;
}

/** a > b as versions (x.y.z, a pre-release is older than its release); unreadable = false. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

export interface CheckResult { enabled: boolean; available: boolean; version: string | null; auto: boolean; staged: string | null }

/**
 * What to do with a check result:
 * - "apply": at start, the update downloaded last session is still the newest: install it now.
 * - "stage": automatic updates: download the new version in the background.
 * - "show": automatic updates off: show it (pill), the player installs by hand.
 * - "none": nothing new, or already downloaded and waiting for the close / Restart now.
 */
export function afterCheck(r: CheckResult, atStart: boolean): 'apply' | 'stage' | 'show' | 'none' {
  if (!r.enabled || !r.available || !r.version) return 'none';
  if (!r.auto) return 'show';
  if (r.staged === r.version) return atStart ? 'apply' : 'none';
  return 'stage';
}

/** The one-time "What's new" sheet: only after an update (not on a fresh install, not after a downgrade). */
export function showWhatsNew(lastSeen: string | null, current: string): boolean {
  return !!lastSeen && newer(current, lastSeen);
}
