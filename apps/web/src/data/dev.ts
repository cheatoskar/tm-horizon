// Developer docs: groups and the sorted list for the navigation (the pages come from the "dev" content collection).
import { getCollection, type CollectionEntry } from 'astro:content';

export const devGroups = ['tutorials', 'publish', 'plugins', 'examples', 'porting', 'api'] as const;
export type DevGroup = (typeof devGroups)[number];
export type DevEntry = CollectionEntry<'dev'>;

export async function devDocs(): Promise<DevEntry[]> {
  const all = await getCollection('dev');
  return all.sort((a, b) => devGroups.indexOf(a.data.group) - devGroups.indexOf(b.data.group) || a.data.order - b.data.order);
}

let headingCache: Map<string, string[]> | null = null;
/** Headings (h2, h3) per doc id, for the search filter in the left navigation. */
export async function devHeadings(): Promise<Map<string, string[]>> {
  if (headingCache) return headingCache;
  const { render } = await import('astro:content');
  const m = new Map<string, string[]>();
  for (const d of await devDocs()) m.set(d.id, (await render(d)).headings.filter((h) => h.depth <= 3).map((h) => h.text));
  headingCache = m;
  return m;
}
