// Which pages the sidebar shows (Settings > Pages, setup wizard). Pure helpers, unit-tested in
// navPages.test.ts. Hiding only removes the sidebar entry: routes, links and buttons still open the page.
// The app keeps the list in settings.json (hiddenPages, src-tauri/src/settings.rs), the browser preview
// in localStorage.

/** Pages that can be hidden, in sidebar order. Home, Library and Mods always stay. */
export const OPTIONAL_PAGES = ['news', 'maps', 'skins', 'media', 'stats', 'profiles', 'servers', 'community'] as const;
export type OptionalPage = (typeof OPTIONAL_PAGES)[number];
export const FIXED_PAGES = ['home', 'library', 'mods'] as const;

/** One-click choices: the optional pages each one shows. */
export const PAGE_PRESETS: { id: 'play' | 'modding' | 'all'; shown: readonly OptionalPage[] }[] = [
  { id: 'play', shown: [] },
  { id: 'modding', shown: ['maps', 'skins', 'profiles', 'media'] },
  { id: 'all', shown: OPTIONAL_PAGES },
];

const isOptional = (p: string): p is OptionalPage => (OPTIONAL_PAGES as readonly string[]).includes(p);

/** Known optional pages only, each once, in sidebar order (what settings.rs keeps too). */
export function cleanHidden(list: readonly string[]): OptionalPage[] {
  return OPTIONAL_PAGES.filter((p) => list.includes(p));
}

/** The hidden list of a preset. */
export function presetHidden(id: string): OptionalPage[] {
  const p = PAGE_PRESETS.find((x) => x.id === id);
  return p ? OPTIONAL_PAGES.filter((o) => !p.shown.includes(o)) : [];
}

/** The preset that matches a hidden list exactly, or null (a custom choice). */
export function presetOf(hidden: readonly string[]): string | null {
  const h = cleanHidden(hidden);
  return PAGE_PRESETS.find((p) => presetHidden(p.id).join() === h.join())?.id ?? null;
}

/** Shows or hides one optional page (fixed and unknown pages are left as they are). */
export function toggleHidden(hidden: readonly string[], page: string): OptionalPage[] {
  if (!isOptional(page)) return cleanHidden(hidden);
  return cleanHidden(hidden.includes(page) ? hidden.filter((p) => p !== page) : [...hidden, page]);
}

/** Whether the sidebar shows a page. A hidden page stays in the sidebar while it is open. */
export function navShows(page: string, hidden: readonly string[], active: string): boolean {
  return !isOptional(page) || !hidden.includes(page) || page === active;
}

/** Reads the stored list (JSON text in the browser preview); anything broken gives "all shown". */
export function parseHidden(text: string): OptionalPage[] {
  try {
    const v: unknown = JSON.parse(text || '[]');
    return Array.isArray(v) ? cleanHidden(v.filter((x): x is string => typeof x === 'string')) : [];
  } catch {
    return [];
  }
}
