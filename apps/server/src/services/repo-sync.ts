// A claimed project with a GitHub repository takes its public face from the repository: showcase.json (or the
// "showcase" key of plugin.json) gives the name (hero title), the short description (hero tagline), the banner
// (hero image), the gallery (first gallery block) and the games (compat rows that work); an icon file at a
// conventional path gives the icon. The owner proved admin rights on the repository, so the repository wins over
// the seeded catalog data. Runs on the claim, on every check of the GitHub source (only when showcase.json or the
// icon changed) and on "Refresh from GitHub" in the portal. Each part is best effort: a picture that does not
// pass the picture checks is skipped and named in the result, the rest still applies.
import { createHash } from 'node:crypto';
import { HUB_GAMES, type GameId, type HubInstall } from '@tm-hub/shared';
import { validateShowcase, type Showcase } from '@tm-hub/shared/showcase';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable } from '../db/db.ts';
import { downloadAsset } from '../sources/github.ts';
import { nowIso, parseJson } from '../util.ts';
import { storeImage } from './images.ts';
import { markIconByAuthor } from './logos.ts';
import { readRepoShowcase, refreshRepoShowcase, showcaseOptions } from './showcase.ts';
import { searchText } from './projects.ts';

/** Where an icon is looked for in the repository when showcase.json has no "icon" (first hit wins; docs/logo/ is the convention). */
export const ICON_PATHS = ['docs/logo/logo-256.png', 'docs/logo/logo-512.png', 'icon.png', 'images/icon.png', 'docs/icon.png', 'docs/images/icon.png', 'assets/icon.png'];
/** Icons are small: the showcase format allows 512 KB. */
const ICON_MAX = 512 * 1024;

export interface RepoSyncResult {
  changed: string[];
  skipped: string[];
  /** false: nothing changed in the repository since the last sync, nothing was fetched beyond showcase.json. */
  ran: boolean;
}

const stateKey = (projectId: string) => `reposync.${projectId}`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function getState(ctx: Ctx, projectId: string): Promise<{ showcase?: string; icon?: string }> {
  const row = await ctx.db.selectFrom('kv').select('value').where('key', '=', stateKey(projectId)).executeTakeFirst();
  return parseJson(row?.value, {});
}
async function setState(ctx: Ctx, projectId: string, v: { showcase?: string; icon?: string }) {
  const value = JSON.stringify(v);
  const r = await ctx.db.updateTable('kv').set({ value }).where('key', '=', stateKey(projectId)).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) await ctx.db.insertInto('kv').values({ key: stateKey(projectId), value }).execute();
}

/** The icon: showcase.json "icon", else the first file of ICON_PATHS that exists. */
async function repoIcon(ctx: Ctx, repo: string, fromShowcase: string | undefined): Promise<{ path: string; data: Buffer } | { path: string; error: string } | null> {
  if (fromShowcase) {
    try { return { path: fromShowcase, data: await downloadAsset(ctx, fromShowcase, ICON_MAX) }; }
    catch (e) { return { path: fromShowcase, error: (e as Error).message }; }
  }
  for (const p of ICON_PATHS) {
    try {
      const data = await downloadAsset(ctx, `https://raw.githubusercontent.com/${repo}/HEAD/${p}`, ICON_MAX);
      if (data.length) return { path: p, data };
    } catch { /* not there (or too large) */ }
  }
  return null;
}

/** Games of the compat block that work (fully or partly), as hub game ids. */
export function compatGames(s: Showcase): GameId[] {
  const out: GameId[] = [];
  for (const b of s.blocks) {
    if (b.type !== 'compat') continue;
    for (const r of b.rows) if ((r.status === 'works' || r.status === 'partial') && HUB_GAMES.includes(r.game) && !out.includes(r.game)) out.push(r.game);
  }
  return out;
}

/**
 * Applies the repository to a claimed project. `force`: also when showcase.json and the icon look unchanged
 * (the portal button); without it the pictures are only fetched when showcase.json changed or never ran.
 */
export async function syncFromRepo(ctx: Ctx, p: ProjectsTable, repo: string, opts: { force?: boolean } = {}): Promise<RepoSyncResult> {
  const res: RepoSyncResult = { changed: [], skipped: [], ran: false };
  if (!p.claimed) { res.skipped.push('not claimed'); return res; }
  const state = await getState(ctx, p.id);
  const raw = await readRepoShowcase(ctx, repo, 'HEAD');
  const rawHash = raw === null ? '' : sha(JSON.stringify(raw));
  const showcaseChanged = rawHash !== (state.showcase ?? null);
  // The icon file is looked at on every check (docs/logo/ may be added at any time, without a showcase.json change);
  // the rest (showcase page, name, games, pictures) only on the first run, on "Refresh" and when showcase.json changed.
  const light = !opts.force && !showcaseChanged && state.icon !== undefined;
  res.ran = !light; // false: only the icon file was looked at

  const v = raw === null ? null : validateShowcase(raw, showcaseOptions(ctx)).showcase;
  const set: Partial<ProjectsTable> = {};
  if (!light) {
    // Showcase page itself (unless the author wrote it in the portal or declined it).
    const sc = await refreshRepoShowcase(ctx, p, repo).catch(() => 'skipped' as const);
    if (sc === 'updated') res.changed.push('showcase');
    if (v) {
      const hero = v.blocks.find((b) => b.type === 'hero') as Extract<Showcase['blocks'][number], { type: 'hero' }> | undefined;
      const name = hero?.title?.trim().slice(0, 64);
      if (name && name.length >= 2 && name !== p.name) { set.name = name; res.changed.push('name'); }
      const tagline = hero?.tagline?.trim();
      if (tagline && tagline.length >= 10 && tagline.slice(0, 200) !== p.summary) { set.summary = tagline.slice(0, 200); res.changed.push('summary'); }
      const games = compatGames(v);
      const now = parseJson<GameId[]>(p.games, []);
      if (games.length && JSON.stringify([...games].sort()) !== JSON.stringify([...now].sort())) {
        set.games = JSON.stringify(games);
        const installs = parseJson<Partial<Record<GameId, HubInstall>>>(p.installs, {});
        const first = Object.values(installs)[0];
        if (first) set.installs = JSON.stringify(Object.fromEntries(games.map((g) => [g, installs[g] ?? first])));
        res.changed.push('games');
      }
      // Banner: the hero picture.
      if (hero?.image && (showcaseChanged || opts.force)) {
        try { await storeImage(ctx, p.id, 'banner', await downloadAsset(ctx, hero.image, ctx.cfg.MAX_IMAGE_MB * 1048576), 0, null); res.changed.push('banner'); }
        catch (e) { res.skipped.push(`banner: ${(e as Error).message}`); }
      }
      // Gallery: the pictures of the first gallery block replace the gallery.
      const gal = v.blocks.find((b) => b.type === 'gallery') as Extract<Showcase['blocks'][number], { type: 'gallery' }> | undefined;
      if (gal?.images.length && (showcaseChanged || opts.force)) {
        const pics: { data: Buffer; caption: string | null }[] = [];
        for (const im of gal.images.slice(0, 12)) {
          try { pics.push({ data: await downloadAsset(ctx, im.url, ctx.cfg.MAX_IMAGE_MB * 1048576), caption: im.caption ?? null }); }
          catch (e) { res.skipped.push(`gallery ${im.url.split('/').pop()}: ${(e as Error).message}`); }
        }
        if (pics.length) {
          const old = await ctx.db.selectFrom('images').select('id').where('project_id', '=', p.id).where('kind', '=', 'gallery').execute();
          if (old.length) await ctx.db.deleteFrom('images').where('id', 'in', old.map((o) => o.id)).execute();
          let order = 0;
          for (const pic of pics) {
            try { await storeImage(ctx, p.id, 'gallery', pic.data, order++, pic.caption); }
            catch (e) { res.skipped.push(`gallery picture: ${(e as Error).message}`); }
          }
          res.changed.push('gallery');
        }
      }
    } else if (raw !== null) {
      res.skipped.push('showcase.json has errors');
    }
  }

  // Icon file of the repository.
  let iconHash = state.icon ?? '';
  const icon = await repoIcon(ctx, repo, v?.icon);
  if (icon && 'error' in icon) res.skipped.push(`icon ${icon.path}: ${icon.error}`);
  else if (icon) {
    const h = sha(icon.data);
    if (h !== state.icon || opts.force) {
      try {
        await storeImage(ctx, p.id, 'icon', icon.data, 0, null);
        await markIconByAuthor(ctx, p.id); // a catalog re-import never puts the catalog logo back over it
        iconHash = h;
        res.changed.push('icon');
      } catch (e) { res.skipped.push(`icon ${icon.path}: ${(e as Error).message}`); iconHash = h; }
    }
  }

  if (Object.keys(set).length) {
    const row = { ...p, ...set };
    await ctx.db.updateTable('projects').set({ ...set, search_text: searchText(row as ProjectsTable), updated_at: nowIso() }).where('id', '=', p.id).execute();
  }
  await setState(ctx, p.id, { showcase: rawHash, icon: iconHash });
  if (res.changed.length) await ctx.audit('system', 'project.repo-sync', p.id, { repo, changed: res.changed, skipped: res.skipped });
  return res;
}
