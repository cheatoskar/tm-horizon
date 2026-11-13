// Showcase pages of a project (packages/shared/src/showcase.ts is the format). Stored as the cleaned JSON in
// `projects.showcase`; `showcase_from` says who wrote it: 'repo' (showcase.json or plugin.json in the
// repository of the mod, refreshed by the crawler), 'portal' (the editor, never overwritten by the crawler),
// 'catalog' (the catalog's seed, packages/catalog/showcases; a repository showcase.json replaces it) or
// 'declined' (no showcase: the author left it out on import; the crawler then keeps out the repository's too).
import { SHOWCASE_IMAGE, validateShowcase, type Showcase, type ShowcaseIssue, type ShowcaseOptions } from '@tm-hub/shared/showcase';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable } from '../db/db.ts';
import { HttpError, nowIso, parseJson } from '../util.ts';
import { repoIn, seedShowcaseFor } from './catalog-seeds.ts';

/** Hub storage is an allowed picture host next to raw.githubusercontent.com, GitHub release assets and i.imgur.com. */
export function showcaseOptions(ctx: Ctx): ShowcaseOptions {
  try {
    return { imageHosts: [new URL(ctx.storage.publicUrl('images/x.png')).hostname] };
  } catch {
    return {};
  }
}

/** The stored showcase of a project, validated again on the way out (lenient: what is wrong is dropped). */
export function storedShowcase(ctx: Ctx, p: Pick<ProjectsTable, 'showcase'>): Showcase | null {
  if (!p.showcase) return null;
  return validateShowcase(parseJson<unknown>(p.showcase, null), showcaseOptions(ctx)).showcase;
}

/** Relative picture paths of a repository showcase.json ("docs/images/a.png") become raw.githubusercontent.com URLs. Only strings in picture fields are touched. */
export function resolveRepoImages(raw: unknown, repo: string, branch: string): unknown {
  const abs = (v: unknown) => (typeof v === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('//') && /\.(png|jpe?g|webp|gif)$/i.test(v) && !v.split('/').includes('..')
    ? `https://raw.githubusercontent.com/${repo}/${branch}/${v.replace(/^\.?\/+/, '').split('/').map(encodeURIComponent).join('/')}` : v);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const doc = structuredClone(raw) as { blocks?: unknown };
  if (!Array.isArray(doc.blocks)) return doc;
  for (const b of doc.blocks as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') continue;
    if ('image' in b) b.image = abs(b.image);
    if ('poster' in b) b.poster = abs(b.poster);
    for (const k of ['before', 'after'] as const) { const s = b[k] as Record<string, unknown> | undefined; if (s && typeof s === 'object' && 'url' in s) s.url = abs(s.url); }
    if (Array.isArray(b.images)) for (const im of b.images as Record<string, unknown>[]) if (im && typeof im === 'object' && 'url' in im) im.url = abs(im.url);
  }
  return doc;
}

/** showcase.json in the repository root, or the "showcase" key of plugin.json. null when there is neither. */
export async function readRepoShowcase(ctx: Ctx, repo: string, branch: string): Promise<unknown | null> {
  const raw = (f: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${f}`;
  try {
    const r = await ctx.fetch(raw('showcase.json'));
    if (r.ok) return resolveRepoImages(JSON.parse((await r.text()).slice(0, 200_000)), repo, branch);
  } catch { /* not there, or not JSON */ }
  try {
    const r = await ctx.fetch(raw('plugin.json'));
    if (r.ok) {
      const j = JSON.parse((await r.text()).slice(0, 300_000)) as { showcase?: unknown };
      if (j && typeof j === 'object' && j.showcase) return resolveRepoImages(j.showcase, repo, branch);
    }
  } catch { /* not there, or not JSON */ }
  return null;
}

/** HEAD check of linked pictures (not the hub storage): a picture that is not an image or is larger than the limit is dropped. A network error keeps it (a flaky host must not delete a showcase). */
export async function dropBadImages(ctx: Ctx, s: Showcase, opts: ShowcaseOptions): Promise<{ showcase: Showcase | null; dropped: string[] }> {
  const own = new Set(opts.imageHosts ?? []);
  const urls = new Set<string>();
  for (const b of s.blocks) {
    const add = (u: string | undefined) => { if (u && !own.has(new URL(u).hostname)) urls.add(u); };
    if (b.type === 'hero') add(b.image);
    if (b.type === 'video') add(b.poster);
    if (b.type === 'gallery') b.images.forEach((i) => add(i.url));
    if (b.type === 'compare') { add(b.before.url); add(b.after.url); }
  }
  const bad = new Map<string, string>();
  await Promise.all([...urls].map(async (u) => {
    try {
      const r = await ctx.fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (!r.ok) { bad.set(u, `HTTP ${r.status}`); return; }
      const type = r.headers.get('content-type') ?? '';
      const len = Number(r.headers.get('content-length') ?? 0);
      if (type && !/^image\/(png|jpeg|webp|gif)\b/i.test(type) && !/octet-stream/i.test(type)) bad.set(u, `not a picture (${type})`);
      else if (len > SHOWCASE_IMAGE.maxBytes) bad.set(u, `larger than ${SHOWCASE_IMAGE.maxBytes / 1048576} MB`);
    } catch { /* unreachable now: keep */ }
  }));
  if (!bad.size) return { showcase: s, dropped: [] };
  // Rebuild without the bad pictures and let the validator drop the blocks that are left empty.
  const kept = structuredClone(s) as unknown as { blocks: Record<string, unknown>[] };
  kept.blocks = kept.blocks.flatMap((b) => {
    if (b.type === 'hero' && bad.has(b.image as string)) delete b.image;
    if (b.type === 'video' && bad.has(b.poster as string)) delete b.poster;
    if (b.type === 'gallery') b.images = (b.images as { url: string }[]).filter((i) => !bad.has(i.url));
    if (b.type === 'compare' && (bad.has((b.before as { url: string }).url) || bad.has((b.after as { url: string }).url))) return [];
    return [b];
  });
  return { showcase: validateShowcase(kept, opts).showcase, dropped: [...bad].map(([u, why]) => `${u}: ${why}`) };
}

/** The showcase a repository offers, cleaned and with bad pictures removed; null when there is none. */
export async function repoShowcase(ctx: Ctx, repo: string, branch: string): Promise<{ showcase: Showcase | null; issues: ShowcaseIssue[]; dropped: string[] } | null> {
  const raw = await readRepoShowcase(ctx, repo, branch);
  if (raw === null) return null;
  const opts = showcaseOptions(ctx);
  const v = validateShowcase(raw, opts);
  if (!v.showcase) return { showcase: null, issues: v.issues, dropped: [] };
  const checked = await dropBadImages(ctx, v.showcase, opts);
  return { showcase: checked.showcase, issues: v.issues, dropped: checked.dropped };
}

/** Saves a showcase from the portal editor. Strict: any issue is a 400 with the list. */
export async function saveShowcase(ctx: Ctx, p: ProjectsTable, raw: unknown, actor: string): Promise<Showcase> {
  const v = validateShowcase(raw, showcaseOptions(ctx));
  if (!v.ok || !v.showcase) {
    throw new HttpError(400, 'bad_showcase', `The showcase has ${v.issues.length || 1} problem(s): ${v.issues.slice(0, 3).map((i) => `${i.path || 'showcase'}: ${i.message}`).join('; ')}`, { issues: v.issues });
  }
  await ctx.db.updateTable('projects').set({ showcase: JSON.stringify(v.showcase), showcase_from: 'portal', updated_at: nowIso() }).where('id', '=', p.id).execute();
  await ctx.audit(actor, 'project.showcase', p.id, { blocks: v.showcase.blocks.length });
  return v.showcase;
}

/** Takes over the repository's showcase.json or the catalog seed (Showcase tab: "Use from repository" / "Copy from catalog"). */
export async function adoptShowcase(ctx: Ctx, p: ProjectsTable, from: 'repo' | 'catalog', actor: string): Promise<Showcase> {
  let showcase: Showcase | null = null;
  if (from === 'catalog') showcase = seedShowcaseFor(p);
  else {
    const repo = repoIn(p.source_url) ?? (await ctx.db.selectFrom('sources').select('target').where('project_id', '=', p.id).where('kind', '=', 'github').executeTakeFirst())?.target ?? null;
    if (repo) showcase = (await repoShowcase(ctx, repo, 'HEAD'))?.showcase ?? null;
  }
  if (!showcase) throw new HttpError(404, 'no_showcase', from === 'catalog' ? 'The catalog has no showcase for this project' : 'The repository has no valid showcase.json');
  await ctx.db.updateTable('projects').set({ showcase: JSON.stringify(showcase), showcase_from: from, updated_at: nowIso() }).where('id', '=', p.id).execute();
  await ctx.audit(actor, 'project.showcase.adopt', p.id, { from, blocks: showcase.blocks.length });
  return showcase;
}

export async function clearShowcase(ctx: Ctx, p: ProjectsTable, actor: string): Promise<void> {
  // 'declined': the crawler does not bring the repository's showcase.json back; "Use from repository" does.
  await ctx.db.updateTable('projects').set({ showcase: null, showcase_from: 'declined', updated_at: nowIso() }).where('id', '=', p.id).execute();
  await ctx.audit(actor, 'project.showcase.clear', p.id, null);
}

/** Crawler: takes the repository showcase over unless the author edited one in the portal. Unchanged data costs two fetches and no write. */
export async function refreshRepoShowcase(ctx: Ctx, p: ProjectsTable, repo: string): Promise<'updated' | 'same' | 'skipped'> {
  if (p.showcase_from === 'portal' || p.showcase_from === 'declined') return 'skipped';
  const raw = await readRepoShowcase(ctx, repo, 'HEAD');
  if (raw === null) return 'skipped';
  const opts = showcaseOptions(ctx);
  const v = validateShowcase(raw, opts);
  if (!v.showcase) return 'skipped';
  if (p.showcase && JSON.stringify(parseJson<unknown>(p.showcase, null)) === JSON.stringify(v.showcase)) return 'same';
  const checked = await dropBadImages(ctx, v.showcase, opts);
  if (!checked.showcase) return 'skipped';
  await ctx.db.updateTable('projects').set({ showcase: JSON.stringify(checked.showcase), showcase_from: 'repo', updated_at: nowIso() }).where('id', '=', p.id).execute();
  return 'updated';
}
