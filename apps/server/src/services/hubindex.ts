// The signed index the launcher reads: every listed project with its published versions, author
// keys and the revocation list. Rebuilt after each publish/revoke/metadata change, cached in the kv
// table (so a restart serves the same document) and served at /v1/index.json.
import type { CatalogEntry, GameId, HubIndexPayload, HubIndexProject, HubIndexSource, HubInstall, HubProjectType, SignedHubIndex } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { signIndex } from '../index/sign.ts';
import { approvedServers } from './gameservers.ts';
import { compareVersions, nowIso, parseJson } from '../util.ts';
import { storedShowcase } from './showcase.ts';
import { filesOf } from './versions.ts';

const cache = new WeakMap<Ctx, { doc: SignedHubIndex; seq: number }>();

const EXTRA_KEY = 'catalog.extra';
/** Catalog entries that are not hub projects (written by the catalog import, release policy applied). */
export async function setCatalogExtra(ctx: Ctx, entries: CatalogEntry[]): Promise<void> {
  const value = JSON.stringify(entries);
  const r = await ctx.db.updateTable('kv').set({ value }).where('key', '=', EXTRA_KEY).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) await ctx.db.insertInto('kv').values({ key: EXTRA_KEY, value }).execute();
}

/** A catalog entry without a hub project as an index entry: no versions, no portal page, the entry itself in catalogEntry. */
function catalogOnly(e: CatalogEntry, generated: string): HubIndexProject {
  return {
    id: `c_${e.id}`, slug: `catalog-${e.id}`, name: e.name, summary: e.description ?? '', author: e.author ?? e.maintainer ?? '', claimed: false,
    catalogId: e.id, catalogOnly: true, icon: null, banner: e.banner ?? null, gallery: e.gallery ?? [], categories: [], tags: [],
    // The catalog's own game ids (the launcher's), not the hub's.
    games: e.games as unknown as GameId[], license: null, links: e.url ? { homepage: e.url } : {}, dependencies: [], conflicts: [],
    authorKeys: [], downloads: 0, updated: generated, versions: [], catalogEntry: e,
  };
}

export async function buildPayload(ctx: Ctx, seq: number): Promise<HubIndexPayload> {
  const projects = await ctx.db.selectFrom('projects').selectAll().where('state', '=', 'listed').orderBy('slug').execute();
  const ids = projects.map((p) => p.id);
  const [versions, images, members, revoked, sources, withdrawn, extraRow, catalogIds] = await Promise.all([
    ids.length ? ctx.db.selectFrom('versions').selectAll().where('status', '=', 'published').where('project_id', 'in', ids).execute() : [],
    ids.length ? ctx.db.selectFrom('images').selectAll().where('project_id', 'in', ids).orderBy('ord').execute() : [],
    ids.length ? ctx.db.selectFrom('members').select(['project_id', 'user_id']).where('project_id', 'in', ids).where('role', 'in', ['owner', 'maintainer']).execute() : [],
    ctx.db.selectFrom('revocations').selectAll().orderBy('revoked_at').execute(),
    ids.length ? ctx.db.selectFrom('sources').select(['project_id', 'kind', 'target', 'product', 'asset_pattern']).where('project_id', 'in', ids).orderBy('created_at').execute() : [],
    ctx.db.selectFrom('projects').select('catalog_id').where('state', 'in', ['hidden', 'removed']).where('catalog_id', 'is not', null).orderBy('catalog_id').execute(),
    ctx.db.selectFrom('kv').select('value').where('key', '=', EXTRA_KEY).executeTakeFirst(),
    ctx.db.selectFrom('projects').select('catalog_id').where('catalog_id', 'is not', null).execute(),
  ]);
  const userIds = [...new Set(members.map((m) => m.user_id))];
  const keys = userIds.length ? await ctx.db.selectFrom('author_keys').selectAll().where('user_id', 'in', userIds).where('revoked_at', 'is', null).execute() : [];
  const generated = nowIso();
  const out: HubIndexProject[] = [];
  for (const p of projects) {
    const vs = versions.filter((v) => v.project_id === p.id).sort((a, b) => compareVersions(b.version, a.version));
    // Catalog projects are listed with their catalog entry even without a hub version (link or GitHub-release install);
    // a claimed one keeps the entry from the import before the claim (the author's own fields win in the launcher).
    const catalogEntry = parseJson<CatalogEntry | null>(p.catalog_entry, null);
    if (!vs.length && !catalogEntry) continue;
    const srcs: HubIndexSource[] = sources.filter((s) => s.project_id === p.id && (s.kind === 'github' || s.kind === 'tmloader'))
      .map((s) => ({ kind: s.kind as 'github' | 'tmloader', target: s.target, ...(s.product ? { product: s.product } : {}), ...(s.asset_pattern ? { asset: s.asset_pattern } : {}) }));
    const imgs = images.filter((i) => i.project_id === p.id);
    const url = (k: string) => ctx.storage.publicUrl(k);
    const icon = imgs.find((i) => i.kind === 'icon');
    const banner = imgs.find((i) => i.kind === 'banner');
    const projectKeys = keys.filter((k) => members.some((m) => m.project_id === p.id && m.user_id === k.user_id));
    const browser = p.type === 'browser-extension';
    out.push({
      id: p.id, slug: p.slug, name: p.name, summary: p.summary, author: p.author_name, claimed: !!p.claimed, catalogId: p.catalog_id,
      ...(p.type ? { type: p.type as HubProjectType } : {}),
      icon: icon ? url(icon.storage_key) : null, banner: banner ? url(banner.storage_key) : null,
      gallery: imgs.filter((i) => i.kind === 'gallery').map((i) => url(i.storage_key)),
      categories: parseJson(p.categories, []), tags: parseJson(p.tags, []), games: parseJson(p.games, []), license: p.license, links: parseJson(p.links, {}),
      dependencies: parseJson(p.dependencies, []), conflicts: parseJson(p.conflicts, []),
      ...(storedShowcase(ctx, p) ? { showcase: storedShowcase(ctx, p)! } : {}),
      authorKeys: projectKeys.map((k) => ({ keyId: k.key_id, publicKey: k.public_key })),
      downloads: p.downloads + (p.github_downloads ?? 0), downloadsBy: { hub: p.downloads, github: p.github_downloads ?? 0 }, updated: p.updated_at,
      versions: vs.map((v) => ({
        id: v.id, version: v.version, channel: v.channel as 'stable' | 'beta', published: v.published_at ?? v.created_at,
        // A browser extension never installs into a game, also not in launchers that do not know the type yet.
        changelog: v.changelog ? v.changelog.slice(0, 4000) : null, installs: browser ? {} : parseJson<Partial<Record<GameId, HubInstall>>>(v.installs, {}),
        files: filesOf(ctx, v),
        authorSignature: parseJson(v.signature, null), verified: !!v.verified,
        ...starForceBlocked(v.report),
      })),
      ...(catalogEntry ? { catalogEntry } : {}),
      ...(srcs.length ? { sources: srcs } : {}),
      ...(p.tmloader_product ? { tmloaderProduct: p.tmloader_product } : {}),
    });
  }
  // Catalog entries without a hub project (in any state: a removed or hidden project never comes back this way).
  const hasProject = new Set(catalogIds.map((c) => c.catalog_id));
  for (const e of parseJson<CatalogEntry[]>(extraRow?.value, [])) if (!hasProject.has(e.id)) out.push(catalogOnly(e, generated));
  return {
    format: 'tmhub-index', schemaVersion: 1, hub: ctx.cfg.HUB_PUBLIC_URL, generated, seq,
    expires: new Date(Date.parse(generated) + ctx.cfg.INDEX_EXPIRES_DAYS * 86400_000).toISOString(),
    projects: out,
    withdrawn: [...new Set(withdrawn.map((w) => w.catalog_id!))].filter((id) => !out.some((o) => o.catalogId === id)),
    servers: await approvedServers(ctx),
    revoked: revoked.map((r) => ({ project: r.project_slug, version: r.version, sha256: r.sha256, reason: r.reason, revoked: r.revoked_at })),
  };
}

async function nextSeq(ctx: Ctx): Promise<number> {
  return ctx.db.transaction().execute(async (tx) => {
    const row = await tx.selectFrom('kv').select('value').where('key', '=', 'index.seq').executeTakeFirst();
    const seq = Number(row?.value ?? 0) + 1;
    if (row) await tx.updateTable('kv').set({ value: String(seq) }).where('key', '=', 'index.seq').execute();
    else await tx.insertInto('kv').values({ key: 'index.seq', value: String(seq) }).execute();
    return seq;
  });
}

/** Files the hub allowed although they are dinput8.dll (checks/dinput8.ts): the launcher never installs them into a StarForce game. */
function starForceBlocked(report: string | null): { starForceBlocked?: string[] } {
  const files = parseJson<{ findings?: { code: string; path?: string }[] }>(report, {}).findings?.filter((f) => f.code === 'type.dinput8.allowed' && f.path).map((f) => f.path!) ?? [];
  return files.length ? { starForceBlocked: [...new Set(files)] } : {};
}

export async function rebuildIndex(ctx: Ctx): Promise<SignedHubIndex> {
  const seq = await nextSeq(ctx);
  const doc = signIndex(await buildPayload(ctx, seq), ctx.key);
  const json = JSON.stringify(doc);
  const exists = await ctx.db.selectFrom('kv').select('key').where('key', '=', 'index.doc').executeTakeFirst();
  if (exists) await ctx.db.updateTable('kv').set({ value: json }).where('key', '=', 'index.doc').execute();
  else await ctx.db.insertInto('kv').values({ key: 'index.doc', value: json }).execute();
  cache.set(ctx, { doc, seq });
  return doc;
}

/** The current signed index; rebuilt when missing, signed by another key, or older than a day (fresh `expires`). */
export async function currentIndex(ctx: Ctx): Promise<SignedHubIndex> {
  let cached = cache.get(ctx);
  // Another process (the catalog import script) may have built a newer index: the stored seq tells.
  if (cached) {
    const s = await ctx.db.selectFrom('kv').select('value').where('key', '=', 'index.seq').executeTakeFirst();
    if (s && Number(s.value) !== cached.seq) { cache.delete(ctx); cached = undefined; }
  }
  if (!cached) {
    const row = await ctx.db.selectFrom('kv').select('value').where('key', '=', 'index.doc').executeTakeFirst();
    const doc = parseJson<SignedHubIndex | null>(row?.value, null);
    const seq = doc ? (JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8')) as HubIndexPayload).seq : 0;
    if (doc) cache.set(ctx, (cached = { doc, seq }));
  }
  if (!cached || cached.doc.keyId !== ctx.key.keyId) return rebuildIndex(ctx);
  const payload = JSON.parse(Buffer.from(cached.doc.payload, 'base64').toString('utf8')) as HubIndexPayload;
  if (Date.now() - Date.parse(payload.generated) > 86400_000) return rebuildIndex(ctx);
  return cached.doc;
}
