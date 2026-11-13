// Featured mods (website home carousel; the launcher can use the same rule). Pure function, no data access.
//
// Rule: score = 0.5 * recency + 0.5 * popularity, best first, at most one mod per author.
//   recency    = 1 for an update in the last 30 days, falling linearly to 0 at 365 days (no date = 0)
//   popularity = log10(1 + downloads + 10 * stars) relative to the most popular candidate (0..1)
// Ties go by name. Authors compare without clan tags ("cheatoskar [TMX]" = "cheatoskar") and case.

export interface FeaturedCandidate {
  id: string;
  name: string;
  author?: string | null;
  /** ISO date of the last update or release. */
  updated?: string | null;
  downloads?: number | null;
  stars?: number | null;
}

const DAY = 86_400_000;
export const authorKey = (a: string | null | undefined) => (a ?? '').replace(/\[[^\]]*\]/g, '').trim().toLowerCase();

export function recencyScore(updated: string | null | undefined, now: number): number {
  const t = updated ? Date.parse(updated) : NaN;
  if (!Number.isFinite(t)) return 0;
  const days = (now - t) / DAY;
  if (days <= 30) return 1;
  if (days >= 365) return 0;
  return 1 - (days - 30) / 335;
}

export function featuredScores<T extends FeaturedCandidate>(list: T[], now = Date.now()): Map<string, number> {
  const pop = (c: T) => Math.log10(1 + Math.max(0, c.downloads ?? 0) + 10 * Math.max(0, c.stars ?? 0));
  const top = Math.max(1e-9, ...list.map(pop));
  return new Map(list.map((c) => [c.id, 0.5 * recencyScore(c.updated, now) + 0.5 * (pop(c) / top)]));
}

/** The `n` featured mods by the rule above (fewer when there are fewer authors). */
export function pickFeatured<T extends FeaturedCandidate>(list: T[], n = 3, now = Date.now()): T[] {
  const score = featuredScores(list, now);
  const sorted = [...list].sort((a, b) => (score.get(b.id)! - score.get(a.id)!) || a.name.localeCompare(b.name));
  const out: T[] = [];
  const authors = new Set<string>();
  for (const c of sorted) {
    const k = authorKey(c.author);
    if (k && authors.has(k)) continue;
    if (k) authors.add(k);
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}
