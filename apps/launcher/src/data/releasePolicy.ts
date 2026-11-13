// Licence policy of public builds (packages/catalog/release-policy.json, rules in docs/legal/permissions.md):
// hidden entries are dropped, link-only entries lose their direct download, and showcases with third-party
// pictures without permission are not used. Preview builds (plain `npm run build`) keep the full catalog.
import policyJson from '@tm-hub/catalog/release-policy.json';

interface Policy { hide: Record<string, string>; linkOnly: Record<string, string>; noShowcase: Record<string, string> }
const policy = policyJson as unknown as Policy;
const on = __PUBLIC_BUILD__;

export const releaseHidden = (id: string): boolean => on && id in policy.hide;

/** Applies the policy to catalog entries in place (the array is shared by reference). */
export function applyReleasePolicy<T extends { id: string; installSpec?: unknown; launcher?: string | null }>(entries: T[]): T[] {
  if (!on) return entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.id in policy.hide) entries.splice(i, 1);
    else if (e.id in policy.linkOnly) entries[i] = { ...e, installSpec: null, launcher: 'open download page' };
  }
  return entries;
}

/** Showcases that public builds may use. */
export function allowedShowcases<T extends { mod: string }>(list: T[] | undefined): T[] | undefined {
  return on && list ? list.filter((s) => !(s.mod in policy.hide) && !(s.mod in policy.noShowcase)) : list;
}
