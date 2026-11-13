// Imports the existing catalog (packages/catalog/catalog.json, incl. the Discord mod-channel entries)
// and the TMLoader mods of the bundled hub data as UNCLAIMED projects: credited to the original
// author, linked to the original source, no files of their own until the crawler copies a release
// (GitHub / TMLoader server) through the normal checks. Authors claim them later.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { CatalogEntry, GameId, HubCategory, HubInstall, Mod } from '@tm-hub/shared';
import { HUB_GAMES, projectTypeOfCatalog } from '@tm-hub/shared';
import { catalogLogoUrl, modIconMap } from '@tm-hub/shared/logo';
import { seedShowcase } from '../services/catalog-seeds.ts';
import { rebuildIndex, setCatalogExtra } from '../services/hubindex.ts';
import { ensureIcon } from '../services/logos.ts';
import type { Ctx } from '../ctx.ts';
import { createProject } from '../services/projects.ts';
import { slugify } from '../util.ts';
import { parseGithubRepo } from './github.ts';
import { addSource } from './crawler.ts';

const GAME: Record<string, GameId> = { 'tmn-eswc': 'eswc', 'tm-original': 'tmo', 'tm-sunrise': 'tms', 'tm-turbo': 'turbo', tmu2006: 'tmuf' };
const toGame = (g: string): GameId | null => { const x = (GAME[g] ?? g) as GameId; return HUB_GAMES.includes(x) ? x : null; };
const CAT: Record<string, HubCategory> = { graphics: 'graphics', hud: 'hud', interface: 'interface', sound: 'sound', music: 'sound', block: 'blocks', blockskin: 'blocks', skin: 'skins', vehicle: 'skins', texturepack: 'graphics', fix: 'fixes', utility: 'tools', medals: 'interface' };
/** Pages about a mod, not mods (same list as the launcher's ModSources.tsx). */
const NOT_MODS = new Set(['tmloader', 'tmloader-site', 'twinkie-site', 'twinkie-org', 'openplanet', 'openplanet-plugins', 'openplanet-nl-old']);

export interface ImportSummary {
  created: string[]; skipped: string[]; sources: number; icons: number;
  /** Catalog projects set to state "hidden": hidden by the release policy or no longer in the catalog (unclaimed only). */
  hidden: string[];
  /** Hidden catalog projects that are back in the catalog (state "listed" again). */
  restored: string[];
}

/** packages/catalog/release-policy.json (launcher licence rules): hide = not listed, linkOnly = no direct download, noShowcase = no seed showcase. */
export interface ReleasePolicy { hide?: Record<string, string>; linkOnly?: Record<string, string>; noShowcase?: Record<string, string> }

/** The catalog entry as public launcher builds show it (apps/launcher/src/data/releasePolicy.ts), or null when hidden. */
export function applyPolicy(e: CatalogEntry, policy: ReleasePolicy): CatalogEntry | null {
  if (policy.hide && e.id in policy.hide) return null;
  if (policy.linkOnly && e.id in policy.linkOnly) return { ...e, installSpec: null, launcher: 'open download page' };
  return e;
}

/** Catalog import states: an unclaimed catalog project the catalog no longer lists is "hidden" (out of the index and the search, restorable by a later import). */
const HIDDEN = 'hidden';

export async function importCatalog(ctx: Ctx, opts: { crawl?: boolean; catalogPath?: string; policyPath?: string | null; modsPath?: string; artPath?: string | URL; icons?: boolean } = {}): Promise<ImportSummary> {
  const require = createRequire(import.meta.url);
  const catalogPath = opts.catalogPath ?? require.resolve('@tm-hub/catalog/catalog.json');
  const modsPath = opts.modsPath ?? new URL('../../../launcher/src/generated/hub/mods.json', import.meta.url);
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { entries: CatalogEntry[] };
  // The release policy next to the catalog (absent on older branches: nothing hidden). null: no policy.
  let policy: ReleasePolicy = {};
  const policyPath = opts.policyPath === undefined ? join(dirname(catalogPath), 'release-policy.json') : opts.policyPath;
  if (policyPath && existsSync(policyPath)) policy = JSON.parse(readFileSync(policyPath, 'utf8')) as ReleasePolicy;
  const noShowcase = (id: string) => !!policy.noShowcase && id in policy.noShowcase;
  let tmlMods: Mod[] = [];
  try { tmlMods = (JSON.parse(readFileSync(modsPath, 'utf8')) as { mods: Mod[] }).mods; } catch { /* optional */ }
  // Logos: the website's art pipeline (entry-art.json) and the TMLoader mod index, picked by the same function the website uses.
  let art: Record<string, { url?: string | null }> = {};
  try { art = JSON.parse(readFileSync(opts.artPath ?? new URL('../../../web/src/data/entry-art.json', import.meta.url), 'utf8')); } catch { /* optional */ }
  const modIcons = modIconMap(tmlMods);
  const out: ImportSummary = { created: [], skipped: [], sources: 0, icons: 0, hidden: [], restored: [] };
  /** Catalog ids this import lists (visible after the policy); every other unclaimed catalog project gets hidden below. */
  const listedIds = new Set<string>();
  const icon = async (projectId: string, url: string | null | undefined) => { if (opts.icons !== false && (await ensureIcon(ctx, projectId, url))) out.icons++; };
  const exists = async (catalogId: string) => !!(await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', catalogId).executeTakeFirst());
  const freeSlug = async (base: string) => {
    let s = slugify(base);
    if (s.length < 3) s += '-mod';
    for (let i = 2; await ctx.db.selectFrom('projects').select('id').where('slug', '=', s).executeTakeFirst(); i++) s = `${slugify(base).slice(0, 44)}-${i}`;
    return s;
  };
  const sourceNext = opts.crawl ? new Date().toISOString() : null;

  /** Visible catalog entries that are not hub projects (websites, exchanges, communities, guides, mods of games the hub does not know): the index lists them as catalog-only entries. */
  const extra: CatalogEntry[] = [];
  for (const raw of catalog.entries) {
    // e: the entry as public launchers show it (linkOnly: no installSpec, so the hub never fetches its files either).
    const e = applyPolicy(raw, policy);
    if (!e) { out.skipped.push(`${raw.id} (hidden by the release policy)`); continue; }
    if (!['mod', 'tool', 'skins', 'tas-plugin', 'browser-addon'].includes(raw.category) || NOT_MODS.has(raw.id)) { extra.push(e); continue; }
    listedIds.add(e.id);
    const entryJson = JSON.stringify(e);
    const linkOnly = !!policy.linkOnly && e.id in policy.linkOnly;
    const discordId = /^\d{15,25}$/.test(e.authorDiscordId ?? '') ? e.authorDiscordId! : null;
    const type = projectTypeOfCatalog(e.category, e.modType);
    const repoOf = e.installSpec?.download.github ?? (e.url ? parseGithubRepo(e.url) : null);
    // The catalog's seed showcase (packages/catalog/showcases) is the project page until the author writes one or the repository has a showcase.json.
    const seed = noShowcase(e.id) ? null : seedShowcase([e.id, e.name], repoOf);
    if (await exists(e.id)) {
      const unclaimed = () => ctx.db.updateTable('projects').where('catalog_id', '=', e.id).where('claimed', '=', 0);
      // Back in the catalog after it was hidden by an earlier import.
      const back = await unclaimed().set({ state: 'listed', updated_at: new Date().toISOString() }).where('state', '=', HIDDEN).executeTakeFirst();
      if (Number(back.numUpdatedRows) > 0) out.restored.push(e.id);
      // The catalog entry the index carries for unclaimed projects (always the current one).
      await unclaimed().set({ catalog_entry: entryJson }).execute();
      // A project claimed before catalog entries were stored gets the current one once (later imports leave it alone).
      await ctx.db.updateTable('projects').set({ catalog_entry: entryJson }).where('catalog_id', '=', e.id).where('claimed', '=', 1).where('catalog_entry', 'is', null).execute();
      // Re-import: a Discord id that was added to the export later reaches projects that are still unclaimed.
      if (discordId) await unclaimed().set({ claim_discord_id: discordId }).where('claim_discord_id', 'is', null).execute();
      // Projects imported before the type and the seed showcases existed get them now (never over an author's choice).
      await ctx.db.updateTable('projects').set({ type }).where('catalog_id', '=', e.id).where('type', 'is', null).execute();
      if (seed) {
        await ctx.db.updateTable('projects').set({ showcase: JSON.stringify(seed), showcase_from: 'catalog' }).where('catalog_id', '=', e.id).where('showcase', 'is', null).where('showcase_from', 'is', null).execute();
        // A newer seed replaces the older catalog seed of an unclaimed project (never a repo or portal showcase).
        await unclaimed().set({ showcase: JSON.stringify(seed) }).where('showcase_from', '=', 'catalog').execute();
      } else if (noShowcase(e.id)) {
        await unclaimed().set({ showcase: null, showcase_from: null }).where('showcase_from', '=', 'catalog').execute();
      }
      if (linkOnly) {
        // Link only: no installs and no sources on the hub (the crawler must not copy its files).
        const ids = (await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', e.id).where('claimed', '=', 0).execute()).map((r) => r.id);
        if (ids.length) {
          await ctx.db.deleteFrom('sources').where('project_id', 'in', ids).execute();
          await ctx.db.updateTable('projects').set({ installs: '{}' }).where('id', 'in', ids).execute();
        }
      }
      const pid = await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', e.id).executeTakeFirst();
      if (pid) await icon(pid.id, catalogLogoUrl(e, modIcons, art)?.url);
      out.skipped.push(`${e.id} (exists)`);
      continue;
    }
    const games = [...new Set([...(e.installSpec?.games ?? []), ...e.games].map(toGame).filter((g): g is GameId => !!g))];
    if (!games.length) { out.skipped.push(`${e.id} (no supported game: catalog-only entry)`); extra.push(e); continue; }
    const spec = e.installSpec;
    const install: HubInstall | null = spec ? (spec.kind === 'tmloader-product' ? { kind: 'tmloader-product', strip: spec.strip ?? 0, include: spec.include ?? [] } : { kind: 'files', base: spec.base ?? 'game', strip: spec.strip ?? 0, include: spec.include ?? [] }) : null;
    const installs = install && type !== 'browser-extension' ? Object.fromEntries(games.map((g) => [g, install])) : {};
    const repo = spec?.download.github ?? (e.url ? parseGithubRepo(e.url) : null);
    const links: Record<string, string> = {};
    if (e.url && /^https:\/\//.test(e.url)) links[repo ? 'source' : 'homepage'] = e.url;
    if (repo) links.issues = `https://github.com/${repo}/issues`;
    const summary = (e.description ?? `${e.name}`).slice(0, 200);
    const author = e.author ?? e.maintainer ?? 'Unknown';
    const p = await createProject(ctx, {
      name: e.name.slice(0, 64), slug: await freeSlug(e.name), summary: summary.length >= 10 ? summary : `${summary} for TrackMania`, games, installs,
      description: [e.description ?? '', e.note ? `\n> ${e.note}` : '', `\n\n*Imported from the TM Horizon catalog; not claimed by its author yet.*${e.downloadNote ? `\n\n${e.downloadNote}` : ''}`].join(''),
      categories: e.category === 'tas-plugin' ? ['tas'] : e.modType && CAT[e.modType] ? [CAT[e.modType]] : e.category === 'tool' ? ['tools'] : e.category === 'skins' ? ['skins'] : [],
      tags: e.modType ? [e.modType.toLowerCase().slice(0, 24)] : [], license: null, links, dependencies: [], conflicts: [], tmloaderProduct: null, type,
    }, null, { author_name: author, catalog_id: e.id, catalog_entry: entryJson, source_url: e.url, state: 'listed', claim_discord_id: discordId, ...(seed ? { showcase: JSON.stringify(seed), showcase_from: 'catalog' } : {}) });
    out.created.push(p.slug);
    await icon(p.id, catalogLogoUrl(e, modIcons, art)?.url);
    if (repo && install && type !== 'browser-extension') {
      const id = await addSource(ctx, p.id, 'github', repo, null, spec?.download.asset ?? null);
      await ctx.db.updateTable('sources').set({ next_check: sourceNext }).where('id', '=', id).execute();
      out.sources++;
    }
  }

  // Unclaimed catalog projects the catalog no longer lists (removed, merged into another id, hidden by the
  // policy) leave the index and the search; a claimed project belongs to its author and is never touched.
  const gone = await ctx.db.selectFrom('projects').select(['id', 'catalog_id']).where('claimed', '=', 0).where('state', '=', 'listed')
    .where('catalog_id', 'is not', null).where('catalog_id', 'not like', 'tmloader:%').execute();
  for (const g of gone) {
    if (listedIds.has(g.catalog_id!)) continue;
    await ctx.db.updateTable('projects').set({ state: HIDDEN, updated_at: new Date().toISOString() }).where('id', '=', g.id).execute();
    out.hidden.push(g.catalog_id!);
  }
  const linkOnlyIds = new Set(Object.keys(policy.linkOnly ?? {}));
  await setCatalogExtra(ctx, extra);

  // TMLoader mods from the TMLoader servers (the loader's own "program" entry is skipped).
  for (const m of tmlMods) {
    if (m.type !== 'modification' || !m.repositories?.length) continue;
    const cid = `tmloader:${m.id}`;
    const have = await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', cid).executeTakeFirst();
    if (have) { await icon(have.id, m.icon); out.skipped.push(`${cid} (exists)`); continue; }
    // Already merged into a project in an earlier import (the same server and product): nothing to do.
    const merged = await ctx.db.selectFrom('sources').innerJoin('projects', 'projects.id', 'sources.project_id').select(['projects.id', 'projects.slug'])
      .where('sources.kind', '=', 'tmloader').where('sources.target', '=', m.repositories[0]).where('sources.product', '=', m.id).executeTakeFirst();
    if (merged) { await icon(merged.id, m.icon); out.skipped.push(`${cid} (merged into ${merged.slug})`); continue; }
    // Same mod already imported from the catalog: give that project the TMLoader server as its source (exact name first).
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cands = await ctx.db.selectFrom('projects').select(['id', 'name', 'slug', 'installs', 'tmloader_product', 'catalog_id', 'state']).where('claimed', '=', 0).execute();
    const twin = cands.find((x) => norm(x.name) === norm(m.name)) ?? cands.find((x) => norm(x.name).startsWith(norm(m.id)));
    // A hidden or link-only catalog twin gets no TMLoader source (and no separate project either).
    if (twin && (twin.state !== 'listed' || linkOnlyIds.has(twin.catalog_id ?? ''))) { out.skipped.push(`${cid} (twin ${twin.slug} is ${twin.state !== 'listed' ? twin.state : 'link only'})`); continue; }
    if (twin) {
      const id = await addSource(ctx, twin.id, 'tmloader', m.repositories[0], m.id, null);
      await ctx.db.updateTable('sources').set({ next_check: sourceNext }).where('id', '=', id).execute();
      const tw = (m.games ?? []).map(toGame).filter((g): g is GameId => !!g);
      const inst = twin.installs === '{}' ? JSON.stringify(Object.fromEntries((tw.length ? tw : ['tmnf', 'tmuf']).map((g) => [g, { kind: 'tmloader-product', strip: 0, include: [] }]))) : twin.installs;
      await ctx.db.updateTable('projects').set({ tmloader_product: twin.tmloader_product ?? m.id, installs: inst }).where('id', '=', twin.id).execute();
      await icon(twin.id, m.icon);
      out.skipped.push(`${cid} (merged into ${twin.slug})`);
      out.sources++;
      continue;
    }
    const games = (m.games ?? []).map(toGame).filter((g): g is GameId => !!g);
    if (!games.length) games.push('tmnf', 'tmuf');
    const install: HubInstall = { kind: 'tmloader-product', strip: 0, include: [] };
    const desc = (m.description ?? `${m.name} for TMLoader`).replace(/\s+/g, ' ');
    const p = await createProject(ctx, {
      name: m.name.slice(0, 64), slug: await freeSlug(m.name), summary: (desc.length >= 10 ? desc : `${desc} (TMLoader mod)`).slice(0, 200), description: `${m.description ?? ''}\n\n*Imported from ${m.repositories[0]}; not claimed by its author yet.*`,
      categories: [], tags: ['tmloader'], games, installs: Object.fromEntries(games.map((g) => [g, install])), license: null, type: 'mod',
      links: m.homepage && /^https:\/\//.test(m.homepage) ? { homepage: m.homepage } : {}, dependencies: [], conflicts: [], tmloaderProduct: m.id,
    }, null, { author_name: m.author ?? 'Unknown', catalog_id: cid, source_url: m.repositories[0], state: 'listed', ...(seedShowcase([m.id, m.name], null) ? { showcase: JSON.stringify(seedShowcase([m.id, m.name], null)), showcase_from: 'catalog' } : {}) });
    const id = await addSource(ctx, p.id, 'tmloader', m.repositories[0], m.id, null);
    await ctx.db.updateTable('sources').set({ next_check: sourceNext }).where('id', '=', id).execute();
    out.created.push(p.slug);
    await icon(p.id, m.icon);
    out.sources++;
  }
  // The index carries the catalog entries of unclaimed projects: rebuild after every import.
  await rebuildIndex(ctx);
  await ctx.audit('system', 'catalog.import', 'catalog', { created: out.created.length, sources: out.sources, icons: out.icons, hidden: out.hidden.length, restored: out.restored.length });
  return out;
}
