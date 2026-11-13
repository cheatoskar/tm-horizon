import { go } from '../state';

/** What Map details opens: a map file, or a map by UID (Statistics rows: the file is looked up in the
 * family's map folders). `family` is a Statistics family or a game id. */
export type InspectTarget = { path: string } | { uid: string; family: string };

/** Route argument of the "map" page. */
export function inspectArg(t: InspectTarget): string {
  return 'path' in t ? `file:${t.path}` : `uid:${t.family}:${t.uid}`;
}

export function parseInspectArg(arg: string | undefined): InspectTarget | null {
  if (!arg) return null;
  if (arg.startsWith('file:')) return { path: arg.slice(5) };
  const m = /^uid:([^:]+):(.+)$/.exec(arg);
  return m ? { family: m[1], uid: m[2] } : null;
}

/** Open Map details (src/pages/MapDetails.tsx). For other pages: Statistics map rows call
 * `inspectMap({ uid, family })`, map lists `inspectMap({ path })`, `inspectMap()` opens the picker. */
export function inspectMap(t?: InspectTarget) {
  go('map', t ? inspectArg(t) : undefined);
}
