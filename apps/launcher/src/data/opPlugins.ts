// Openplanet plugins: which game folders a plugin can go into, version compare, and finding the
// openplanet.dev plugin behind a hub "More projects" entry. Pure helpers (opPlugins.test.ts).

export interface OpPluginLike { id: number; identifier: string; name: string; games: string[]; version: string; page: string }

/** One launcher game per Openplanet folder: Trackmania (OpenplanetNext), ManiaPlanet 4 (Openplanet4), Turbo. */
export function opGamesOf(p: Pick<OpPluginLike, 'games'>): string[] {
  const out: string[] = [];
  for (const g of p.games) {
    const l = g.toLowerCase();
    const id = l === 'trackmania' ? 'tm2020' : l.includes('turbo') ? 'tm-turbo' : l.startsWith('maniaplanet') ? 'tm2-stadium' : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The plugin's games that are installed here (any ManiaPlanet title counts for ManiaPlanet 4). */
export function opTargets(p: Pick<OpPluginLike, 'games'>, installed: string[]): string[] {
  const have = (g: string) => g === 'tm2-stadium' ? installed.some((x) => x.startsWith('tm2-') || x === 'sm-storm') : installed.includes(g);
  return opGamesOf(p).filter(have);
}

/** a > b for plugin versions ("1.10.2" > "1.9"); the same rules as openplanet.rs `newer`. */
export function opNewer(a: string, b: string): boolean {
  const parts = (s: string) => s.replace(/^v/i, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === q) continue;
    if (p === undefined) return typeof q === 'string';
    if (q === undefined) return typeof p === 'number' ? x.slice(i).some((r) => typeof r === 'number' && r > 0) : false;
    if (typeof p === 'number' && typeof q === 'number') return p > q;
    if (typeof p === 'number') return true;
    if (typeof q === 'number') return false;
    return p > q;
  }
  return false;
}

/** The openplanet.dev plugin of a hub "More projects" entry: its openplanet.dev page, else the repository
 * name equal to the plugin identifier. */
export function matchOpPlugin<T extends OpPluginLike>(entry: { link: string; repo: string | null }, catalog: T[]): T | null {
  const page = /^https:\/\/(?:www\.)?openplanet\.dev\/plugin\/([\w.-]+)\/?$/i.exec(entry.link)?.[1]?.toLowerCase();
  if (page) {
    const hit = catalog.find((p) => p.page.toLowerCase().replace(/\/+$/, '').endsWith('/plugin/' + page));
    if (hit) return hit;
  }
  const repo = entry.repo?.split('/').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!repo) return null;
  return catalog.find((p) => p.identifier.toLowerCase().replace(/[^a-z0-9]/g, '') === repo) ?? null;
}
