// Where a catalog entry's logo comes from. One function for the website's build (apps/web/scripts/fetch-entry-art.mjs,
// step 1) and the hub's catalog import, so both pick the same picture:
//   1. the icon of the same project in the TMLoader mod index (apps/launcher/src/generated/hub/mods.json),
//   2. the picture found by the website's art pipeline (apps/web/src/data/entry-art.json: id -> url).

/** Same key the website uses to match names: lower case, letters and digits only. */
export const logoKey = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** id/name -> icon URL of the TMLoader mod index. */
export function modIconMap(mods: { id?: string; name?: string; icon?: string | null }[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of mods ?? []) if (x.icon) { m.set(logoKey(x.id), x.icon); m.set(logoKey(x.name), x.icon); }
  m.delete('');
  return m;
}

export function catalogLogoUrl(
  e: { id: string; name: string },
  modIcons: Map<string, string>,
  art: Record<string, { url?: string | null }> = {},
): { url: string; source: 'tmloader-index' | 'entry-art' } | null {
  for (const k of [logoKey(e.name), logoKey(String(e.id).replace(/^(tas|mod)-/, ''))]) {
    const u = modIcons.get(k);
    if (u) return { url: u, source: 'tmloader-index' };
  }
  const a = art[e.id]?.url;
  return a ? { url: a, source: 'entry-art' } : null;
}
