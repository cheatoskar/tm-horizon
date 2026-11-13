// Showcase page of a mod (packages/shared/src/showcase.ts): from the hub index (an author's own page,
// signed index, opt-in source) first, else the bundled catalog's `showcases` list (packages/catalog/showcases/*.json).
// Found by any of the mod's ids or names, like the related links. Always cleaned again here: nothing from
// the index or the catalog is trusted to be valid.
import catalogJson from '@tm-hub/catalog/catalog.json';
import { cleanShowcase, showcaseOf, type Showcase } from '@tm-hub/shared/showcase';
import { hubPayload } from './hubIndex';
import { allowedShowcases } from './releasePolicy';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const SHOWCASES = allowedShowcases((catalogJson as unknown as { showcases?: { mod: string; showcase: unknown }[] }).showcases);

export function showcaseFor(...keys: (string | null | undefined)[]): Showcase | null {
  const want = new Set(keys.filter((k): k is string => !!k).map(norm));
  if (!want.size) return null;
  const pl = hubPayload();
  if (pl) {
    const host = (() => { try { return new URL(pl.hub).hostname; } catch { return ''; } })();
    // Picture hosts of the hub: its own storage lives on the hub's host or a sibling (files.<host>); the index is signed, the pictures are still checked by host.
    const hit = pl.projects.find((p) => p.showcase && (want.has(norm(p.slug)) || want.has(norm(p.name)) || (p.catalogId && want.has(norm(p.catalogId)))));
    if (hit?.showcase) {
      const hosts = [host, ...(['gallery', 'banner', 'icon'] as const).flatMap((k) => { const v = hit[k]; return (Array.isArray(v) ? v : v ? [v] : []).map((u) => { try { return new URL(u, pl.hub).hostname; } catch { return ''; } }); })].filter(Boolean);
      const s = cleanShowcase(hit.showcase, { imageHosts: hosts });
      if (s) return s;
    }
  }
  return showcaseOf(SHOWCASES, ...keys);
}
