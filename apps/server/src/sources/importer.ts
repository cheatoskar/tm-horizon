// "Paste your GitHub repo URL (or TMLoader server URL) once": preview what the hub found, then create
// the project with the source attached. Name, summary, README, licence, links, screenshots, install
// type (from the file layout) and the first version are taken over; the author can edit all of it later.
import { PROJECT_TYPES, projectTypeOfCatalog, type GameId, type HubInstall, type HubProjectType, type ProjectInput, type SourcePreview } from '@tm-hub/shared';
import { cleanRelatedLinks } from '@tm-hub/shared/links';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable } from '../db/db.ts';
import { HttpError, compareVersions, parseJson, slugify } from '../util.ts';
import { isZip, unzipAll } from '../checks/zip.ts';
import { isPe } from '../checks/pe.ts';
import { discordInMarkdown, downloadAsset, getReleases, getRepo, githubDownloadTotal, githubHeaders, globMatch, parseGithubRepo, pickAsset, repoImages } from './github.ts';
import { catalogEntryForRepo, seedShowcase } from '../services/catalog-seeds.ts';
import { sql } from 'kysely';
import { addSource, checkSource, fetchTmlIndex, normalizeServer } from './crawler.ts';
import { createProject, needsInstall, updateProject } from '../services/projects.ts';
import { rebuildIndex } from '../services/hubindex.ts';
import { storeImage } from '../services/images.ts';
import { adoptShowcase, repoShowcase } from '../services/showcase.ts';

/** Install type from the file layout. browser: a browser extension (manifest.json with manifest_version at the top). */
export function detectInstall(name: string, data: Buffer): { install: HubInstall | null; reason: string; browser?: boolean } {
  if (isPe(data) && /\.dll$/i.test(name)) return { install: null, reason: 'A single DLL: choose "TMLoader mod" (the hub wraps it) or "next to the game exe" (proxy DLL).' };
  if (!isZip(data)) return { install: null, reason: 'Not a zip; choose where the file goes.' };
  let paths: string[];
  try { paths = unzipAll(data).files.filter((f) => !f.path.includes('!/')).map((f) => f.path); } catch (e) { return { install: null, reason: `The zip did not pass the checks: ${(e as Error).message}` }; }
  if (paths.some((p) => /^[^/]+\/[^/]+\/description\.yaml$/i.test(p))) return { install: { kind: 'tmloader-product', strip: 0, include: [] }, reason: 'TMLoader layout (<Product>/<version>/description.yaml).' };
  if (paths.some((p) => /^[^/]+\/[^/]+\/[^/]+\/description\.yaml$/i.test(p))) return { install: { kind: 'tmloader-product', strip: 1, include: [] }, reason: 'TMLoader layout inside a top folder.' };
  const top = paths.find((p) => /^([^/]+\/)?manifest\.json$/i.test(p));
  if (top) {
    try {
      const m = JSON.parse(unzipAll(data).files.find((f) => f.path === top)!.data.toString('utf8')) as { manifest_version?: unknown };
      if (typeof m.manifest_version === 'number') return { install: null, browser: true, reason: 'A browser extension (manifest.json): not installed into a game.' };
    } catch { /* not a browser manifest */ }
  }
  const firstDirs = new Set(paths.map((p) => p.split('/')[0].toLowerCase()));
  const known = /^(gamedata|skins|tracks|mediatracker|scores|plugins|scripts)$/;
  const single = firstDirs.size === 1 && paths.every((p) => p.includes('/')) && !known.test([...firstDirs][0]) ? 1 : 0;
  const rel = paths.map((p) => p.split('/').slice(single).join('/').toLowerCase());
  if (rel.some((p) => p.startsWith('gamedata/'))) return { install: { kind: 'files', base: 'game', strip: single, include: [] }, reason: 'Contains a GameData folder: copied next to the game exe.' };
  if (rel.some((p) => /^(skins|tracks|mediatracker|scores)\//.test(p))) return { install: { kind: 'files', base: 'documents', strip: single, include: [] }, reason: 'Skins/Tracks folders: copied into Documents\\TrackMania.' };
  if (rel.some((p) => /\.as$/.test(p))) return { install: { kind: 'files', base: 'tmi-plugins', strip: single, include: [] }, reason: 'AngelScript files: TMInterface plugin.' };
  if (rel.some((p) => /\.dll$/.test(p))) return { install: { kind: 'files', base: 'game', strip: single, include: [] }, reason: 'DLLs at the top: copied next to the game exe (proxy DLL).' };
  if (rel.length && rel.every((p) => /\.(gbx|dds|tga|png|jpg|ogg|wav|mux|fx|hlsl|zip|pak)$/.test(p))) return { install: { kind: 'files', base: 'gamedata', strip: single, include: [] }, reason: 'Game assets: copied into GameData.' };
  return { install: null, reason: 'Layout not recognised; choose where the files go.' };
}

async function uniqueSlug(ctx: Ctx, base: string): Promise<string> {
  let s = slugify(base);
  if (s.length < 3) s = `${s}-mod`;
  for (let i = 2; await ctx.db.selectFrom('projects').select('id').where('slug', '=', s).executeTakeFirst(); i++) s = `${slugify(base).slice(0, 44)}-${i}`;
  return s;
}

async function readme(ctx: Ctx, repo: string, branch: string): Promise<string> {
  try {
    const r = await ctx.fetch(`https://api.github.com/repos/${repo}/readme`, { headers: githubHeaders(ctx, { accept: 'application/vnd.github.raw' }) });
    if (!r.ok) return '';
    const md = (await r.text()).slice(0, 50_000);
    // Relative links and pictures -> absolute GitHub URLs.
    return md.replace(/(!?\[[^\]]*\]\()(?!https?:|#|mailto:)([^)\s]+)/g, (_m, pre: string, path: string) =>
      `${pre}${pre.startsWith('!') ? `https://raw.githubusercontent.com/${repo}/${branch}/` : `https://github.com/${repo}/blob/${branch}/`}${path.replace(/^\.?\//, '')}`);
  } catch {
    return '';
  }
}

/** `links` of the repository's plugin.json (optional file in the root): [{kind, label, url}], validated; anything invalid is dropped. */
export async function repoRelatedLinks(ctx: Ctx, repo: string, branch: string): Promise<ReturnType<typeof cleanRelatedLinks>> {
  try {
    const r = await ctx.fetch(`https://raw.githubusercontent.com/${repo}/${branch}/plugin.json`);
    if (!r.ok) return [];
    const j = JSON.parse((await r.text()).slice(0, 100_000)) as { links?: unknown };
    return cleanRelatedLinks(j?.links);
  } catch {
    return [];
  }
}

/** A TMLoader index product may carry the same `links` list. */
const relatedOfProduct = (p: unknown) => cleanRelatedLinks((p as { links?: unknown } | null | undefined)?.links);

/** A project that is about this repository without a watched source yet (a catalog project: its source link or homepage is the repository). Unclaimed ones first. */
export async function projectOfRepo(ctx: Ctx, fullName: string): Promise<{ slug: string; claimed: number; viaRepo: true } | undefined> {
  const needle = `github.com/${fullName}`.toLowerCase();
  const rows = await ctx.db.selectFrom('projects').select(['slug', 'claimed', 'source_url', 'links']).where('state', '!=', 'removed')
    .where(sql<boolean>`(lower(coalesce(source_url, '')) like ${'%' + needle + '%'} or lower(links) like ${'%' + needle + '%'})`).orderBy('claimed', 'asc').execute();
  // The repository name must end there: "owner/repo" is not "owner/repo-2".
  const names = (text: string) => {
    const t = text.toLowerCase();
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      const next = t.charAt(i + needle.length);
      if (!/[a-z0-9._-]/.test(next)) return true;
    }
    return false;
  };
  const hit = rows.find((p) => names(`${p.source_url ?? ''} ${p.links}`));
  return hit ? { slug: hit.slug, claimed: hit.claimed, viaRepo: true } : undefined;
}

/** Network trouble while reading a source is the source's problem, not a hub error: 502 with the reason. */
export async function previewSource(ctx: Ctx, url: string, product: string | null, inspect = true): Promise<SourcePreview> {
  try {
    return await previewInner(ctx, url, product, inspect);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'source_unreachable', `Could not read ${url}: ${(e as Error).message}`);
  }
}

/** Project type from the repository topics. */
function typeOfTopics(topics: string[]): HubProjectType | null {
  const t = new Set(topics.map((x) => x.toLowerCase()));
  if (['browser-extension', 'chrome-extension', 'firefox-extension', 'firefox-addon', 'webextension', 'userscript'].some((x) => t.has(x))) return 'browser-extension';
  if (t.has('openplanet') || t.has('openplanet-plugin')) return 'openplanet-plugin';
  if (t.has('tminterface')) return 'tmi-plugin';
  if (t.has('tas')) return 'tas';
  return null;
}

/** Project type from the detected install (file layout). */
function typeOfInstall(i: HubInstall | null, browser: boolean): HubProjectType | null {
  if (browser) return 'browser-extension';
  if (!i) return null;
  if (i.kind === 'tmloader-product') return 'mod';
  if (i.base === 'tmi-plugins' || i.base === 'tmi-scripts') return 'tmi-plugin';
  return null;
}

async function previewInner(ctx: Ctx, url: string, product: string | null, inspect: boolean): Promise<SourcePreview> {
  const repo = parseGithubRepo(url);
  const warnings: string[] = [];
  if (repo) {
    const r = await getRepo(ctx, repo);
    if (!r) throw new HttpError(404, 'repo_not_found', 'Repository not found or not public');
    if (r.archived) warnings.push('The repository is archived; no new releases will come.');
    const rels = await getReleases(ctx, r.fullName);
    const latest = rels.releases.find((x) => !x.prerelease) ?? rels.releases[0] ?? null;
    if (!latest) warnings.push('No releases yet. The hub imports the first release as soon as it appears.');
    const pick = latest ? pickAsset(latest.assets, null) : { asset: null, candidates: [] };
    if (latest && !pick.candidates.length) warnings.push('The newest release has no .zip or .dll file attached.');
    if (latest && !pick.asset && pick.candidates.length > 1) warnings.push('Several files fit; pick the one players need.');
    let install: HubInstall | null = null;
    let browser = false;
    let installReason = 'No file to look at yet; choose how it installs.';
    if (inspect && pick.asset && pick.asset.size <= 50 * 1048576) {
      try {
        const d = detectInstall(pick.asset.name, await downloadAsset(ctx, pick.asset.url, 50 * 1048576));
        install = d.install;
        installReason = d.reason;
        browser = !!d.browser;
      } catch (e) {
        installReason = `Could not read the release file: ${(e as Error).message}`;
      }
    } else if (inspect && !pick.asset && pick.candidates.length > 1 && pick.candidates.every((a) => /chrome|firefox|edge|opera|browser/i.test(a.name))) {
      browser = true;
      installReason = 'One file per browser: a browser extension.';
    }
    const existing = (await ctx.db.selectFrom('sources').innerJoin('projects', 'projects.id', 'sources.project_id').select(['projects.slug', 'projects.claimed'])
      .where('sources.kind', '=', 'github').where('sources.target', '=', r.fullName).executeTakeFirst()) ?? (await projectOfRepo(ctx, r.fullName));
    const related = await repoRelatedLinks(ctx, r.fullName, r.defaultBranch);
    const showcase = (await repoShowcase(ctx, r.fullName, 'HEAD'))?.showcase ?? null;
    const description = await readme(ctx, r.fullName, r.defaultBranch);
    const images = await repoImages(ctx, r.fullName, r.defaultBranch, description, latest);
    const discord = discordInMarkdown(description);
    const entry = catalogEntryForRepo(r.fullName);
    const catalogShowcase = seedShowcase([entry?.id, entry?.name, r.name], r.fullName);
    const fromCatalog = entry ? projectTypeOfCatalog(entry.category, entry.modType) : null;
    const fromTopics = typeOfTopics(r.topics);
    const fromFiles = typeOfInstall(install, browser);
    const type = fromCatalog ?? fromTopics ?? fromFiles;
    const typeReason = fromCatalog ? `The TM Horizon catalog lists it as "${entry!.category}${entry!.modType ? ` / ${entry!.modType}` : ''}".`
      : fromTopics ? 'From the repository topics.' : fromFiles ? 'From the files in the newest release.' : 'Not clear from the repository; choose one.';
    const assetInfo = pick.candidates.map((a) => ({ name: a.name, size: a.size, downloads: a.downloads ?? 0 }));
    let githubDownloads: number | null = null;
    try { githubDownloads = await githubDownloadTotal(ctx, r.fullName); } catch { /* shown as unknown */ }
    return {
      kind: 'github', target: r.fullName, products: [], product: null, name: r.name.replace(/[-_]+/g, ' '), slug: await uniqueSlug(ctx, r.name),
      summary: (r.description ?? `${r.name} by ${r.owner}`).slice(0, 200), description, author: r.owner, license: r.license,
      links: {
        source: r.htmlUrl, issues: `${r.htmlUrl}/issues`, ...(r.homepage && /^https:\/\//.test(r.homepage) ? { homepage: r.homepage } : {}),
        ...(discord ? { discord } : {}), ...(related.length ? { related } : {}),
      },
      images: images.map((i) => i.url), imageFrom: images.map((i) => i.from), type, typeReason,
      catalog: entry ? { id: entry.id, name: entry.name } : null, catalogShowcase,
      latest: latest ? { version: latest.tag.replace(/^v/i, ''), tag: latest.tag, published: latest.published, prerelease: latest.prerelease } : null,
      assets: pick.candidates.map((a) => a.name), assetInfo, asset: pick.asset?.name ?? null, install, installReason, githubDownloads,
      existing: existing ? { slug: existing.slug, claimed: !!existing.claimed, ...('viaRepo' in existing ? { viaRepo: true } : {}) } : null, showcase, warnings,
    };
  }
  const server = normalizeServer(url);
  if (!server) throw new HttpError(400, 'bad_url', 'Paste a GitHub repository URL or the https URL of a TMLoader server');
  const { index } = await fetchTmlIndex(ctx, server).catch((e) => { throw new HttpError(422, 'no_index', `No TMLoader index at ${server}index.json (${(e as Error).message})`); });
  const products = Object.entries(index?.products ?? {}).map(([id, p]) => ({ id, name: p.name ?? id, versions: Object.keys(p.versions ?? {}).length }));
  if (!products.length) throw new HttpError(422, 'no_products', 'The TMLoader index lists no products');
  const chosen = product ?? (products.length === 1 ? products[0].id : null);
  const p = chosen ? index!.products![chosen] : null;
  if (chosen && !p) throw new HttpError(404, 'no_product', `Product ${chosen} is not on this server`);
  const versions = Object.keys(p?.versions ?? {});
  const last = [...versions].sort(compareVersions).pop() ?? null;
  const existing = chosen ? await ctx.db.selectFrom('sources').innerJoin('projects', 'projects.id', 'sources.project_id').select(['projects.slug', 'projects.claimed'])
    .where('sources.kind', '=', 'tmloader').where('sources.target', '=', server).where('sources.product', '=', chosen).executeTakeFirst() : undefined;
  const catalogShowcase = seedShowcase([chosen, p?.name], null);
  return {
    kind: 'tmloader', target: server, products, product: chosen, name: p?.name ?? chosen ?? '', slug: chosen ? await uniqueSlug(ctx, p?.name ?? chosen) : '',
    summary: (p?.description ?? `${p?.name ?? chosen} for TMLoader`).slice(0, 200), description: p?.description ?? '', author: p?.author ?? 'Unknown', license: null,
    links: { ...(p?.homepage && /^https:\/\//.test(p.homepage) ? { homepage: p.homepage } : {}), ...(relatedOfProduct(p).length ? { related: relatedOfProduct(p) } : {}) },
    images: [], imageFrom: [], type: 'mod', typeReason: 'TMLoader servers carry game mods.', catalog: null, catalogShowcase,
    latest: last ? { version: last, tag: last, published: null, prerelease: false } : null, assets: [], assetInfo: [], asset: null, githubDownloads: null,
    install: { kind: 'tmloader-product', strip: 0, include: [] }, installReason: 'TMLoader server: installed like TMLoader does (the hub adds the product folder).',
    existing: existing ? { slug: existing.slug, claimed: !!existing.claimed } : null, showcase: null, warnings: chosen ? [] : ['Pick the product.'],
  };
}

export interface ImportOptions {
  url: string;
  product?: string | null;
  slug?: string;
  name?: string;
  games: GameId[];
  install: HubInstall;
  assetPattern?: string | null;
  /** What the project is (the portal asks; the catalog crawl guesses). */
  type?: HubProjectType | null;
  /**
   * What the author confirmed in the import preview. Every item left out (undefined) falls back to the old
   * behaviour only for `summary`, `license` and `links`; pictures, README and showcase are imported only when chosen.
   */
  summary?: string;
  /** Long description (README or the author's text); undefined = the README (API clients before the preview existed). */
  description?: string;
  license?: string | null;
  links?: ProjectInput['links'];
  /** Pictures out of the preview's `images`, in gallery order. */
  images?: string[];
  /** One of the preview's pictures as the project banner. */
  banner?: string | null;
  /** Which showcase to take: the repository's showcase.json, the catalog seed, or none. undefined = the repository's (old behaviour). */
  showcase?: 'repo' | 'catalog' | null;
  /** false: the source is attached, but the current releases are skipped; only later releases come in. */
  importLatest?: boolean;
}

/** Creates the project (owner = user; null = unclaimed crawl), attaches the source and runs the first check. */
export async function importFromUrl(ctx: Ctx, opts: ImportOptions, owner: { id: string; name: string } | null, extra: Partial<ProjectsTable> = {}) {
  const pv = await previewSource(ctx, opts.url, opts.product ?? null, false);
  // A project found only by the repository link (a catalog project) blocks a person's import (claim it instead) but not the hub's own crawl, which attaches the source to it.
  if (pv.existing && (owner || !pv.existing.viaRepo)) throw new HttpError(409, 'source_exists', `This source belongs to the project "${pv.existing.slug}" already${pv.existing.claimed ? '' : ' (unclaimed: claim it instead)'}`, pv.existing);
  if (pv.kind === 'tmloader' && !pv.product) throw new HttpError(400, 'pick_product', 'Pick the product first');
  // Several release files fit and none was chosen: the project would sit in "needs a choice" forever.
  if (opts.importLatest !== false && pv.kind === 'github' && pv.assets.length > 1 && !pv.asset && !(opts.assetPattern && pv.assets.some((a) => globMatch(opts.assetPattern!, a)))) {
    throw new HttpError(400, 'pick_asset', 'Several release files fit: choose the one to install');
  }
  const pictures = [...(opts.images ?? []), ...(opts.banner ? [opts.banner] : [])];
  const unknown = pictures.filter((u) => !pv.images.includes(u));
  if (unknown.length) throw new HttpError(400, 'unknown_image', 'Pictures must come from the preview');
  const type = opts.type ?? null;
  // A browser extension is never installed into a game: no install per game.
  const installs = (type === 'browser-extension' || (type && PROJECT_TYPES[type].delivery === 'link') ? {} : Object.fromEntries(opts.games.map((g) => [g, opts.install]))) as ProjectInput['installs'];
  const summary = (opts.summary ?? pv.summary).trim();
  const input: ProjectInput = {
    name: (opts.name ?? pv.name).slice(0, 64), slug: opts.slug ?? pv.slug, type, summary: summary.length >= 10 ? summary.slice(0, 200) : `${summary} (mod)`.padEnd(10, '.'),
    description: opts.description ?? pv.description, categories: [], tags: [], games: opts.games, installs, license: opts.license !== undefined ? opts.license : pv.license,
    links: opts.links ?? pv.links, dependencies: [], conflicts: [],
    tmloaderProduct: pv.kind === 'tmloader' ? pv.product : opts.install.kind === 'tmloader-product' && Object.keys(installs).length ? (pv.name.replace(/[^\w .+-]/g, '').slice(0, 64) || null) : null,
  };
  const wantShowcase = opts.showcase === undefined ? (pv.showcase ? 'repo' : null) : opts.showcase;
  const showcase = wantShowcase === 'repo' ? pv.showcase : wantShowcase === 'catalog' ? pv.catalogShowcase : null;
  if (wantShowcase && !showcase) throw new HttpError(400, 'no_showcase', wantShowcase === 'repo' ? 'The repository has no valid showcase.json' : 'The catalog has no showcase for this project');
  const project = await createProject(ctx, input, owner, {
    author_name: owner?.name ?? pv.author, source_url: opts.url,
    ...(showcase ? { showcase: JSON.stringify(showcase), showcase_from: wantShowcase } : opts.showcase === null && pv.showcase ? { showcase_from: 'declined' } : {}), ...extra,
  });
  const sourceId = await addSource(ctx, project.id, pv.kind, pv.target, pv.product, opts.assetPattern ?? null);
  // Pictures the author picked (best effort: one that is not a usable picture is reported, the import goes on).
  const pictureErrors: string[] = [];
  let order = 0;
  for (const u of (opts.images ?? []).slice(0, 12)) {
    try {
      const data = await downloadAsset(ctx, u, ctx.cfg.MAX_IMAGE_MB * 1048576);
      await storeImage(ctx, project.id, 'gallery', data, order++, null);
    } catch (e) { pictureErrors.push(`${u.split('/').pop()}: ${(e as Error).message}`); }
  }
  if (opts.banner) {
    try { await storeImage(ctx, project.id, 'banner', await downloadAsset(ctx, opts.banner, ctx.cfg.MAX_IMAGE_MB * 1048576), 0, null); }
    catch (e) { pictureErrors.push(`banner ${opts.banner.split('/').pop()}: ${(e as Error).message}`); }
  }
  if (opts.importLatest === false && pv.kind === 'github') {
    // The current releases count as seen: only releases after the import come in.
    const rels = await getReleases(ctx, pv.target);
    for (const rel of rels.releases) await ctx.db.insertInto('source_seen').values({ source_id: sourceId, ref: rel.tag, status: 'skipped', at: new Date().toISOString() }).execute();
    await ctx.db.updateTable('sources').set({ last_check: new Date().toISOString() }).where('id', '=', sourceId).execute();
  }
  const first = await checkSource(ctx, sourceId);
  return { project, sourceId, first, pictureErrors };
}

/**
 * Connects a GitHub repository to an existing project and runs the first check right away (several fitting release
 * files: the check says so and the Versions tab offers the choice). Without games/install type there is nothing to
 * install a release as, so the source is connected and the first check waits (the project page says what is missing).
 */
export async function connectGithubSource(ctx: Ctx, p: ProjectsTable, repo: string, assetPattern: string | null = null) {
  const sourceId = await addSource(ctx, p.id, 'github', repo, null, assetPattern);
  const fresh = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  if (needsInstall(fresh)) return { sourceId, first: null };
  return { sourceId, first: await checkSource(ctx, sourceId) };
}

export interface ApplyOptions {
  url: string;
  summary?: string; description?: string; license?: string | null;
  links?: ProjectInput['links']; images?: string[]; banner?: string | null; showcase?: 'repo' | 'catalog' | null;
  games?: GameId[]; install?: HubInstall; assetPattern?: string | null;
}

/**
 * "Import from GitHub" on an existing project: the same preview as for a new project, but only the items the owner
 * ticked are applied (every field left out stays as it is). Pictures must come from the preview. Links are added to
 * the existing ones; gallery pictures are appended; the repository becomes the project's source.
 */
export async function applyGithubImport(ctx: Ctx, p: ProjectsTable, opts: ApplyOptions, actor: string) {
  const pv = await previewSource(ctx, opts.url, null, false);
  if (pv.kind !== 'github') throw new HttpError(400, 'not_github', 'Only GitHub repositories can be imported into an existing project');
  if (pv.existing && pv.existing.slug !== p.slug) throw new HttpError(409, 'source_exists', `This repository belongs to the project "${pv.existing.slug}"`, pv.existing);
  const pictures = [...(opts.images ?? []), ...(opts.banner ? [opts.banner] : [])];
  if (pictures.some((u) => !pv.images.includes(u))) throw new HttpError(400, 'unknown_image', 'Pictures must come from the preview');
  const applied: string[] = [];
  const patch: Record<string, unknown> = {};
  if (opts.summary !== undefined) { patch.summary = opts.summary; applied.push('summary'); }
  if (opts.description !== undefined) { patch.description = opts.description; applied.push('description'); }
  if (opts.license !== undefined) { patch.license = opts.license; applied.push('license'); }
  if (opts.links && Object.keys(opts.links).length) { patch.links = { ...parseJson<Record<string, unknown>>(p.links, {}), ...opts.links }; applied.push('links'); }
  if (opts.games?.length && opts.install && needsInstall(p)) {
    const noInstall = p.type && PROJECT_TYPES[p.type as HubProjectType]?.delivery !== 'game';
    patch.games = opts.games;
    if (!noInstall) patch.installs = Object.fromEntries(opts.games.map((g) => [g, opts.install]));
    applied.push('games');
  }
  if (Object.keys(patch).length) await updateProject(ctx, p, patch as Parameters<typeof updateProject>[2], actor);
  const pictureErrors: string[] = [];
  if (opts.images?.length) {
    const last = await ctx.db.selectFrom('images').select((eb) => eb.fn.max('ord').as('m')).where('project_id', '=', p.id).executeTakeFirst();
    let order = Number(last?.m ?? -1) + 1, n = 0;
    for (const u of opts.images.slice(0, 12)) {
      try { await storeImage(ctx, p.id, 'gallery', await downloadAsset(ctx, u, ctx.cfg.MAX_IMAGE_MB * 1048576), order++, null); n++; }
      catch (e) { pictureErrors.push(`${u.split('/').pop()}: ${(e as Error).message}`); }
    }
    if (n) applied.push(`${n} gallery pictures`);
  }
  if (opts.banner) {
    try { await storeImage(ctx, p.id, 'banner', await downloadAsset(ctx, opts.banner, ctx.cfg.MAX_IMAGE_MB * 1048576), 0, null); applied.push('banner'); }
    catch (e) { pictureErrors.push(`banner ${opts.banner.split('/').pop()}: ${(e as Error).message}`); }
  }
  if (opts.showcase) {
    const fresh = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
    await adoptShowcase(ctx, fresh, opts.showcase, actor);
    applied.push('showcase');
  }
  const fresh = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  const conn = await connectGithubSource(ctx, fresh, pv.target, opts.assetPattern ?? null);
  await ctx.audit(actor, 'project.import-github', p.id, { applied, repo: pv.target });
  if (fresh.state === 'listed') await rebuildIndex(ctx);
  return { applied, sourceId: conn.sourceId, first: conn.first, pictureErrors };
}
