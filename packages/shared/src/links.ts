// Related links of a mod ("Dazu gehört"): a companion page (bingo board, settings page), docs, Discord,
// source, website. The same shape in the catalog (`links`), the hub server (`links.related` of a
// project) and plugin.json. Only https; unknown kinds are refused.

export const RELATED_KINDS = ['companion', 'docs', 'discord', 'source', 'website'] as const;
export type RelatedKind = (typeof RELATED_KINDS)[number];

export interface RelatedLink {
  kind: RelatedKind;
  /** Button text, e.g. "Bingo-Board". */
  label: string;
  url: string;
}

export const MAX_RELATED = 8;
export const isRelatedKind = (k: unknown): k is RelatedKind => typeof k === 'string' && (RELATED_KINDS as readonly string[]).includes(k);

/** A clean https URL (no credentials, at most 500 characters), or null. */
export function cleanHttpsUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 500) return null;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'https:' || x.username || x.password || !x.hostname.includes('.')) return null;
    return x.toString();
  } catch {
    return null;
  }
}

/** One link as it is stored; null when kind, label or url is not valid. */
export function cleanRelatedLink(raw: unknown): RelatedLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = cleanHttpsUrl(r.url);
  const label = typeof r.label === 'string' ? r.label.trim().replace(/\s+/g, ' ') : '';
  if (!isRelatedKind(r.kind) || !url || label.length < 1 || label.length > 40) return null;
  return { kind: r.kind, label, url };
}

/** Valid links only, no duplicates by URL, companion first (stable), at most MAX_RELATED. For data from outside (plugin.json, catalog files). */
export function cleanRelatedLinks(raw: unknown): RelatedLink[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RelatedLink[] = [];
  for (const x of raw) {
    const l = cleanRelatedLink(x);
    if (!l || seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
  }
  return sortRelated(out).slice(0, MAX_RELATED);
}

export const sortRelated = (l: RelatedLink[]): RelatedLink[] =>
  [...l].sort((a, b) => RELATED_KINDS.indexOf(a.kind) - RELATED_KINDS.indexOf(b.kind));
