// Projects: metadata, team, images, search. Slugs never change after creation (author signatures
// and launcher deep links refer to them).
import { z } from 'zod';
import { sql } from 'kysely';
import { HUB_CATEGORIES, HUB_GAMES, HUB_INSTALL_TYPES, HUB_PROJECT_TYPES, PROJECT_TYPES, type HubProjectType, type DownloadBreakdown, type GameId, type HubImage, type HubProject, type HubSource, type ProjectInput, type ProjectRole, type SearchQuery, type SearchResult, type StatementOfReasons } from '@tm-hub/shared';
import { MAX_RELATED, RELATED_KINDS } from '@tm-hub/shared/links';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable } from '../db/db.ts';
import { HttpError, SLUG_RE, compareVersions, forbidden, newId, notFound, nowIso, parseJson } from '../util.ts';
import { isAdmin } from './users.ts';
import { storedShowcase } from './showcase.ts';
import { seedShowcaseFor } from './catalog-seeds.ts';

const httpsUrl = z.string().trim().max(400).url().refine((u) => /^https:\/\//i.test(u), 'https only');
const relatedLinkSchema = z.object({ kind: z.enum(RELATED_KINDS), label: z.string().trim().min(1).max(40), url: httpsUrl });
const installSchema = z.object({
  kind: z.enum(['tmloader-product', 'files']),
  base: z.enum(['game', 'gamedata', 'documents', 'tmi-plugins', 'tmi-scripts']).optional(),
  strip: z.number().int().min(0).max(3).optional(),
  include: z.array(z.string().max(200).regex(/^[^:]*$/).refine((p) => !p.split(/[\\/]/).includes('..'), 'no ..')).max(20).optional(),
}).refine((i) => i.kind === 'tmloader-product' || !!i.base, 'files installs need a base folder');
const dep = z.object({ id: z.string().trim().min(1).max(64), version: z.string().trim().max(40).nullable(), tmloader: z.boolean().optional() });
export const gameEnum = z.enum(HUB_GAMES as [GameId, ...GameId[]]);
/** Empty is allowed on a project (unclaimed imports without install data); a version needs at least one game. */
export const installsSchema = z.partialRecord(gameEnum, installSchema);

export const projectTypeSchema = z.enum(HUB_PROJECT_TYPES);
export const projectInputSchema = z.object({
  name: z.string().trim().min(2).max(64),
  /** Optional here (catalog imports, old clients); the portal routes that create a project require it. */
  type: projectTypeSchema.nullable().optional(),
  slug: z.string().regex(SLUG_RE, '3-48 characters: a-z, 0-9 and single dashes'),
  summary: z.string().trim().min(10).max(200),
  description: z.string().max(50_000),
  categories: z.array(z.enum(HUB_CATEGORIES)).max(4),
  tags: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9 -]{0,23}$/)).max(10),
  games: z.array(gameEnum).min(1).max(12),
  installs: installsSchema,
  license: z.string().trim().max(64).nullable(),
  links: z.object({
    homepage: httpsUrl.optional(), source: httpsUrl.optional(), issues: httpsUrl.optional(), discord: httpsUrl.optional(),
    related: z.array(relatedLinkSchema).max(MAX_RELATED).optional(),
  }),
  dependencies: z.array(dep).max(20),
  conflicts: z.array(dep).max(20),
  tmloaderProduct: z.string().trim().regex(/^[\w .+-]{1,64}$/).nullable().optional(),
});
export const projectPatchSchema = projectInputSchema.omit({ slug: true }).partial().extend({ type: projectTypeSchema.optional() });
/** POST /v1/projects: the author has to say what the project is. */
export const projectCreateSchema = projectInputSchema.extend({ type: projectTypeSchema });

const RESERVED_SLUGS = new Set(['new', 'admin', 'api', 'login', 'logout', 'me', 'settings', 'search', 'legal', 'impressum', 'datenschutz', 'terms', 'report', 'p', 'v1', 'dl', 'files']);

const searchText = (p: { name: string; summary: string; author_name: string; tags: string; slug: string; description?: string }) =>
  [p.name, p.slug, p.author_name, p.summary, parseJson<string[]>(p.tags, []).join(' '), (p.description ?? '').slice(0, 2000)].join(' ').toLowerCase().replace(/\s+/g, ' ');

export async function roleIn(ctx: Ctx, projectId: string, userId: string | null): Promise<ProjectRole | null> {
  if (!userId) return null;
  const m = await ctx.db.selectFrom('members').select('role').where('project_id', '=', projectId).where('user_id', '=', userId).executeTakeFirst();
  return (m?.role as ProjectRole) ?? null;
}

/** Throws unless the user has one of the roles (admins always pass). */
export async function requireRole(ctx: Ctx, projectId: string, userId: string, roles: ProjectRole[]): Promise<ProjectRole | 'admin'> {
  const r = await roleIn(ctx, projectId, userId);
  if (r && roles.includes(r)) return r;
  if (await isAdmin(ctx, userId)) return 'admin';
  throw forbidden('You are not allowed to do this for this project');
}

export async function projectBySlug(ctx: Ctx, slug: string): Promise<ProjectsTable> {
  const p = await ctx.db.selectFrom('projects').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!p) throw notFound('Project not found');
  return p;
}

export async function createProject(ctx: Ctx, input: ProjectInput, owner: { id: string; name: string } | null, extra: Partial<ProjectsTable> = {}): Promise<ProjectsTable> {
  const v = projectInputSchema.parse(input);
  if (RESERVED_SLUGS.has(v.slug)) throw new HttpError(409, 'slug_taken', 'This name is reserved');
  if (await ctx.db.selectFrom('projects').select('id').where('slug', '=', v.slug).executeTakeFirst()) throw new HttpError(409, 'slug_taken', 'This slug is taken');
  const at = nowIso();
  const row: ProjectsTable = {
    id: newId('p'), slug: v.slug, name: v.name, summary: v.summary, description: v.description, categories: JSON.stringify(v.categories), tags: JSON.stringify(v.tags),
    games: JSON.stringify(v.games), installs: JSON.stringify(v.installs), license: v.license, links: JSON.stringify(v.links), dependencies: JSON.stringify(v.dependencies),
    conflicts: JSON.stringify(v.conflicts), author_name: owner?.name ?? 'Unknown', claimed: owner ? 1 : 0, catalog_id: null, state: 'draft', removal: null,
    icon_id: null, banner_id: null, downloads: 0, search_text: '', owner_changed_at: null, tmloader_product: v.tmloaderProduct ?? null, source_url: null, claim_discord_id: null, showcase: null, showcase_from: null, type: v.type ?? null, github_downloads: 0, github_downloads_at: null,
    created_at: at, updated_at: at, ...extra,
  };
  row.search_text = searchText(row);
  await ctx.db.insertInto('projects').values(row).execute();
  if (owner) await ctx.db.insertInto('members').values({ project_id: row.id, user_id: owner.id, role: 'owner', added_at: at }).execute();
  await ctx.audit(owner?.id ?? 'system', 'project.create', row.id, { slug: row.slug });
  return row;
}

export async function updateProject(ctx: Ctx, p: ProjectsTable, patch: z.infer<typeof projectPatchSchema>, actor: string): Promise<ProjectsTable> {
  const v = projectPatchSchema.parse(patch);
  const set: Partial<ProjectsTable> = { updated_at: nowIso() };
  if (v.name !== undefined) set.name = v.name;
  if (v.type !== undefined) set.type = v.type;
  if (v.summary !== undefined) set.summary = v.summary;
  if (v.description !== undefined) set.description = v.description;
  if (v.categories) set.categories = JSON.stringify(v.categories);
  if (v.tags) set.tags = JSON.stringify(v.tags);
  if (v.games) set.games = JSON.stringify(v.games);
  if (v.installs) set.installs = JSON.stringify(v.installs);
  if (v.license !== undefined) set.license = v.license;
  if (v.links) set.links = JSON.stringify(v.links);
  if (v.dependencies) set.dependencies = JSON.stringify(v.dependencies);
  if (v.conflicts) set.conflicts = JSON.stringify(v.conflicts);
  if (v.tmloaderProduct !== undefined) set.tmloader_product = v.tmloaderProduct;
  const next = { ...p, ...set };
  set.search_text = searchText(next);
  await ctx.db.updateTable('projects').set(set).where('id', '=', p.id).execute();
  await ctx.audit(actor, 'project.update', p.id, Object.keys(v));
  return { ...next, search_text: set.search_text };
}

export function imageOf(ctx: Ctx, i: { id: string; kind: string; storage_key: string; width: number; height: number; ord: number; caption: string | null }): HubImage {
  return { id: i.id, url: ctx.storage.publicUrl(i.storage_key), kind: i.kind as HubImage['kind'], width: i.width, height: i.height, order: i.ord, caption: i.caption };
}

export async function sourcesOf(ctx: Ctx, projectId: string): Promise<HubSource[]> {
  const rows = await ctx.db.selectFrom('sources').selectAll().where('project_id', '=', projectId).orderBy('created_at').execute();
  return rows.map((s) => ({
    id: s.id, kind: s.kind as HubSource['kind'], target: s.target, product: s.product, assetPattern: s.asset_pattern, lastCheck: s.last_check, nextCheck: s.next_check,
    lastError: s.last_error, imported: s.imported, needsChoice: parseJson(s.needs_choice, null), webhook: !!s.webhook,
  }));
}

/** What "Downloads" adds up to for a project (hub.ts DownloadBreakdown). */
export function downloadBreakdown(p: Pick<ProjectsTable, 'downloads' | 'github_downloads' | 'claim_discord_id' | 'source_url'>, sourceKinds: string[]): DownloadBreakdown {
  const github = sourceKinds.includes('github') ? p.github_downloads ?? 0 : null;
  const notCounted: DownloadBreakdown['notCounted'] = [];
  if (sourceKinds.includes('tmloader')) notCounted.push('tmloader');
  if (p.claim_discord_id || /discord(app)?\.(com|gg)\//i.test(p.source_url ?? '')) notCounted.push('discord');
  return { total: p.downloads + (github ?? 0), hub: p.downloads, github, notCounted };
}

export async function toHubProject(ctx: Ctx, p: ProjectsTable, viewer: string | null): Promise<HubProject> {
  const [images, team, myRole, latest, kinds] = await Promise.all([
    ctx.db.selectFrom('images').selectAll().where('project_id', '=', p.id).orderBy('ord').execute(),
    ctx.db.selectFrom('members').innerJoin('users', 'users.id', 'members.user_id').select(['users.id', 'users.name', 'users.avatar', 'members.role']).where('project_id', '=', p.id).execute(),
    roleIn(ctx, p.id, viewer),
    ctx.db.selectFrom('versions').select('version').where('project_id', '=', p.id).where('status', '=', 'published').execute(),
    ctx.db.selectFrom('sources').select('kind').where('project_id', '=', p.id).execute(),
  ]);
  const downloadStats = downloadBreakdown(p, kinds.map((k) => k.kind));
  const showSources = !!myRole || (viewer ? await isAdmin(ctx, viewer) : false);
  return {
    id: p.id, slug: p.slug, name: p.name, type: (p.type as HubProject['type']) ?? null, summary: p.summary, description: p.description, categories: parseJson(p.categories, []), tags: parseJson(p.tags, []),
    games: parseJson(p.games, []), installs: parseJson(p.installs, {}), license: p.license, links: parseJson(p.links, {}), dependencies: parseJson(p.dependencies, []),
    conflicts: parseJson(p.conflicts, []), tmloaderProduct: p.tmloader_product, author: p.author_name, claimed: !!p.claimed, discordClaimable: !p.claimed && !!p.claim_discord_id, catalogId: p.catalog_id,
    state: p.state as HubProject['state'], removal: parseJson<StatementOfReasons | null>(p.removal, null),
    icon: images.find((i) => i.kind === 'icon') ? imageOf(ctx, images.find((i) => i.kind === 'icon')!) : null,
    banner: images.find((i) => i.kind === 'banner') ? imageOf(ctx, images.find((i) => i.kind === 'banner')!) : null,
    gallery: images.filter((i) => i.kind === 'gallery').map((i) => imageOf(ctx, i)),
    showcase: storedShowcase(ctx, p), showcaseFrom: p.showcase && p.showcase_from ? (p.showcase_from as HubProject['showcaseFrom']) : null,
    catalogShowcase: !!seedShowcaseFor(p),
    team: team.map((t) => ({ user: { id: t.id, name: t.name, avatar: t.avatar }, role: t.role as ProjectRole })),
    sources: showSources ? await sourcesOf(ctx, p.id) : [],
    downloads: downloadStats.total, downloadStats, created: p.created_at, updated: p.updated_at, myRole,
    latest: latest.map((v) => v.version).sort(compareVersions).pop() ?? null,
  };
}

/** Listed projects only; token search over name, author, summary, tags and the start of the description. */
export async function searchProjects(ctx: Ctx, q: SearchQuery): Promise<SearchResult> {
  const limit = Math.min(Math.max(q.limit ?? 24, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  let query = ctx.db.selectFrom('projects').where('state', '=', 'listed');
  const tokens = (q.q ?? '').toLowerCase().split(/\s+/).map((t) => t.replace(/[%_\\]/g, '')).filter(Boolean).slice(0, 6);
  for (const t of tokens) query = query.where('search_text', 'like', `%${t}%`);
  if (q.game) query = query.where('games', 'like', `%"${q.game}"%`);
  if (q.category) query = query.where('categories', 'like', `%"${q.category}"%`);
  if (q.tag) query = query.where('tags', 'like', `%"${q.tag.toLowerCase().replace(/["%_\\]/g, '')}"%`);
  if (q.install && (HUB_INSTALL_TYPES as readonly string[]).includes(q.install)) {
    const [kind, base] = q.install.split(':');
    query = query.where('installs', 'like', base ? `%"base":"${base}"%` : `%"kind":"${kind}"%`);
  }
  const total = Number((await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0);
  const order = q.sort === 'updated' ? 'updated_at' : q.sort === 'new' ? 'created_at' : q.sort === 'name' ? 'name' : null;
  let rows = query.selectAll();
  // Relevance first when searching: name hits before description hits.
  if (tokens.length) rows = rows.orderBy(sql`case when lower(name) like ${'%' + tokens[0] + '%'} then 0 else 1 end`);
  // "popular": total downloads (TM Horizon + GitHub release files).
  rows = order ? rows.orderBy(order, order === 'name' ? 'asc' : 'desc') : rows.orderBy(sql`downloads + github_downloads`, 'desc');
  const list = await rows.orderBy('slug').limit(limit).offset((page - 1) * limit).execute();
  const ids = list.map((p) => p.id);
  const icons = ids.length ? await ctx.db.selectFrom('images').select(['project_id', 'storage_key']).where('kind', '=', 'icon').where('project_id', 'in', ids).execute() : [];
  const versions = ids.length ? await ctx.db.selectFrom('versions').select(['project_id', 'version']).where('status', '=', 'published').where('project_id', 'in', ids).execute() : [];
  return {
    total, page,
    items: list.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, summary: p.summary, author: p.author_name, claimed: !!p.claimed, categories: parseJson(p.categories, []), tags: parseJson(p.tags, []),
      games: parseJson(p.games, []), downloads: p.downloads + (p.github_downloads ?? 0), updated: p.updated_at,
      latest: versions.filter((v) => v.project_id === p.id).map((v) => v.version).sort(compareVersions).pop() ?? null,
      icon: (() => { const i = icons.find((x) => x.project_id === p.id); return i ? ctx.storage.publicUrl(i.storage_key) : null; })(),
    })),
  };
}

/** A project that installs nothing cannot take a release file yet (a browser extension or a link-only type never does). */
export function needsInstall(p: Pick<ProjectsTable, 'installs' | 'type'>): boolean {
  if (Object.keys(parseJson<Record<string, unknown>>(p.installs, {})).length) return false;
  const delivery = p.type && p.type in PROJECT_TYPES ? PROJECT_TYPES[p.type as HubProjectType].delivery : null;
  return delivery !== 'browser' && delivery !== 'link';
}
