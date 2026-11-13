// Imports the existing catalog (packages/catalog/catalog.json, incl. the Discord mod-channel entries)
// and the TMLoader mods of the bundled hub data as UNCLAIMED projects: credited to the original
// author, linked to the original source, no files of their own until the crawler copies a release
// (GitHub / TMLoader server) through the normal checks. Authors claim them later.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { CatalogEntry, GameId, HubCategory, HubInstall, Mod } from '@tm-hub/shared';
import { HUB_GAMES, projectTypeOfCatalog } from '@tm-hub/shared';
import { catalogLogoUrl, modIconMap } from '@tm-hub/shared/logo';
import { seedShowcase } from '../services/catalog-seeds.ts';
import { rebuildIndex } from '../services/hubindex.ts';
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

export interface ImportSummary { created: string[]; skipped: string[]; sources: number; icons: number }

export async function importCatalog(ctx: Ctx, opts: { crawl?: boolean; catalogPath?: string; modsPath?: string; artPath?: string | URL; icons?: boolean } = {}): Promise<ImportSummary> {
  const require = createRequire(import.meta.url);
  const catalogPath = opts.catalogPath ?? require.resolve('@tm-hub/catalog/catalog.json');
  const modsPath = opts.modsPath ?? new URL('../../../launcher/src/generated/hub/mods.json', import.meta.url);
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { entries: CatalogEntry[] };
  let tmlMods: Mod[] = [];
  try { tmlMods = (JSON.parse(readFileSync(modsPath, 'utf8')) as { mods: Mod[] }).mods; } catch { /* optional */ }
  // Logos: the website's art pipeline (entry-art.json) and the TMLoader mod index, picked by the same function the website uses.
  let art: Record<string, { url?: string | null }> = {};
  try { art = JSON.parse(readFileSync(opts.artPath ?? new URL('../../../web/src/data/entry-art.json', import.meta.url), 'utf8')); } catch { /* optional */ }
  const modIcons = modIconMap(tmlMods);
  const out: ImportSummary = { created: [], skipped: [], sources: 0, icons: 0 };
  const icon = async (projectId: string, url: string | null | undefined) => { if (opts.icons !== false && (await ensureIcon(ctx, projectId, url))) out.icons++; };
  const exists = async (catalogId: string) => !!(await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', catalogId).executeTakeFirst());
  const freeSlug = async (base: string) => {
    let s = slugify(base);
    if (s.length < 3) s += '-mod';
    for (let i = 2; await ctx.db.selectFrom('projects').select('id').where('slug', '=', s).executeTakeFirst(); i++) s = `${slugify(base).slice(0, 44)}-${i}`;
    return s;
  };
  const sourceNext = opts.crawl ? new Date().toISOString() : null;

  for (const e of catalog.entries) {
    if (!['mod', 'tool', 'skins', 'tas-plugin', 'browser-addon'].includes(e.category) || NOT_MODS.has(e.id)) continue;
    const discordId = /^\d{15,25}$/.test(e.authorDiscordId ?? '') ? e.authorDiscordId! : null;
    const type = projectTypeOfCatalog(e.category, e.modType);
    const repoOf = e.installSpec?.download.github ?? (e.url ? parseGithubRepo(e.url) : null);
    // The catalog's seed showcase (packages/catalog/showcases) is the project page until the author writes one or the repository has a showcase.json.
    const seed = seedShowcase([e.id, e.name], repoOf);
    if (await exists(e.id)) {
      // Re-import: a Discord id that was added to the export later reaches projects that are still unclaimed.
      if (discordId) await ctx.db.updateTable('projects').set({ claim_discord_id: discordId }).where('catalog_id', '=', e.id).where('claimed', '=', 0).where('claim_discord_id', 'is', null).execute();
      // Projects imported before the type and the seed showcases existed get them now (never over an author's choice).
      await ctx.db.updateTable('projects').set({ type }).where('catalog_id', '=', e.id).where('type', 'is', null).execute();
      if (seed) await ctx.db.updateTable('projects').set({ showcase: JSON.stringify(seed), showcase_from: 'catalog' }).where('catalog_id', '=', e.id).where('showcase', 'is', null).where('showcase_from', 'is', null).execute();
      const pid = await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', e.id).executeTakeFirst();
      if (pid) await icon(pid.id, catalogLogoUrl(e, modIcons, art)?.url);
      out.skipped.push(`${e.id} (exists)`);
      continue;
    }
    const games = [...new Set([...(e.installSpec?.games ?? []), ...e.games].map(toGame).filter((g): g is GameId => !!g))];
    if (!games.length) { out.skipped.push(`${e.id} (no supported game)`); continue; }
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
    }, null, { author_name: author, catalog_id: e.id, source_url: e.url, state: 'listed', claim_discord_id: discordId, ...(seed ? { showcase: JSON.stringify(seed), showcase_from: 'catalog' } : {}) });
    out.created.push(p.slug);
    await icon(p.id, catalogLogoUrl(e, modIcons, art)?.url);
    if (repo && install && type !== 'browser-extension') {
      const id = await addSource(ctx, p.id, 'github', repo, null, spec?.download.asset ?? null);
      await ctx.db.updateTable('sources').set({ next_check: sourceNext }).where('id', '=', id).execute();
      out.sources++;
    }
  }

  // TMLoader mods from the TMLoader servers (the loader's own "program" entry is skipped).
  for (const m of tmlMods) {
    if (m.type !== 'modification' || !m.repositories?.length) continue;
    const cid = `tmloader:${m.id}`;
    const have = await ctx.db.selectFrom('projects').select('id').where('catalog_id', '=', cid).executeTakeFirst();
    if (have) { await icon(have.id, m.icon); out.skipped.push(`${cid} (exists)`); continue; }
    // Same mod already imported from the catalog: give that project the TMLoader server as its source.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const twin = (await ctx.db.selectFrom('projects').select(['id', 'name', 'slug', 'installs', 'tmloader_product']).where('claimed', '=', 0).execute())
      .find((x) => norm(x.name) === norm(m.name) || norm(x.name).startsWith(norm(m.id)));
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
  if (out.icons) await rebuildIndex(ctx);
  await ctx.audit('system', 'catalog.import', 'catalog', { created: out.created.length, sources: out.sources, icons: out.icons });
  return out;
}
