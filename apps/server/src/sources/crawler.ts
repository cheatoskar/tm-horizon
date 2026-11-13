// Watches connected sources (GitHub repositories, TMLoader servers) and copies each new release
// into the hub as an immutable version, through the same checks, hold and review as an upload.
// Polling is adaptive: sources with a release in the last 60 days every CRAWL_ACTIVE_MIN minutes,
// quiet ones every CRAWL_QUIET_MIN; errors back off up to a day. GitHub webhooks (GitHub App) and
// "Check now" set next_check to now.
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable, SourcesTable } from '../db/db.ts';
import { addMinutes, compareVersions, newId, nowIso, parseJson } from '../util.ts';
import { downloadAsset, getReleases, githubDownloadTotal, globMatch, patternFromName, pickAsset, type GhRelease } from './github.ts';
import { browserLabel, ingestVersion, versionMetaSchema } from '../services/versions.ts';
import { refreshRepoShowcase } from '../services/showcase.ts';
import { syncFromRepo } from '../services/repo-sync.ts';
import { needsInstall } from '../services/projects.ts';
import { autoSetup } from '../services/autosetup.ts';

export interface TmlIndexVersion { download_link?: string; hash_sha256?: string; executable?: string; dependencies?: { id: string; version?: string | null }[]; changelog?: string; priority?: number }
export interface TmlIndex { products?: Record<string, { name?: string; author?: string; description?: string; homepage?: string; versions?: Record<string, TmlIndexVersion> }> }

/** TMLoader server base URL (https, ends with "/"), or null. */
export function normalizeServer(u: string): string | null {
  try {
    const url = new URL(u.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    let s = url.toString().replace(/index\.json$/i, '');
    if (!s.endsWith('/')) s += '/';
    return s;
  } catch {
    return null;
  }
}

export async function fetchTmlIndex(ctx: Ctx, server: string, etag?: string | null): Promise<{ status: number; etag: string | null; index: TmlIndex | null }> {
  const r = await ctx.fetch(server + 'index.json', { headers: { 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)', ...(etag ? { 'if-none-match': etag } : {}) } });
  if (r.status === 304) return { status: 304, etag: etag ?? null, index: null };
  if (!r.ok) throw new Error(`TMLoader index: HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 5_000_000) throw new Error('TMLoader index too large');
  return { status: r.status, etag: r.headers.get('etag'), index: JSON.parse(text) as TmlIndex };
}

const versionOf = (tag: string) => tag.replace(/^(release[-_ ]?|version[-_ ]?)/i, '').replace(/^v/i, '');
const validVersion = (v: string) => versionMetaSchema.shape.version.safeParse(v).success;

async function seen(ctx: Ctx, sourceId: string, ref: string) {
  return !!(await ctx.db.selectFrom('source_seen').select('ref').where('source_id', '=', sourceId).where('ref', '=', ref).executeTakeFirst());
}
async function setKv(ctx: Ctx, key: string, value: string) {
  await ctx.db.deleteFrom('kv').where('key', '=', key).execute();
  await ctx.db.insertInto('kv').values({ key, value }).execute();
}
async function markSeen(ctx: Ctx, sourceId: string, ref: string, status: string) {
  await ctx.db.deleteFrom('source_seen').where('source_id', '=', sourceId).where('ref', '=', ref).execute();
  await ctx.db.insertInto('source_seen').values({ source_id: sourceId, ref, status, at: nowIso() }).execute();
}

/** Sum of GitHub release file downloads into projects.github_downloads (once a day per project; force = now). */
export async function refreshGithubDownloads(ctx: Ctx, p: ProjectsTable, repo: string, force = false): Promise<number | null> {
  if (!force && p.github_downloads_at && Date.now() - Date.parse(p.github_downloads_at) < 86400_000) return null;
  const n = await githubDownloadTotal(ctx, repo);
  await ctx.db.updateTable('projects').set({ github_downloads: n, github_downloads_at: nowIso() }).where('id', '=', p.id).execute();
  return n;
}

export interface CheckResult { imported: string[]; skipped: string[]; needsChoice: { tag: string; assets: string[] } | null; unchanged: boolean; error: string | null }

async function importGithubRelease(ctx: Ctx, s: SourcesTable, p: ProjectsTable, rel: GhRelease, res: CheckResult): Promise<'imported' | 'choice' | 'skipped'> {
  // A setup step, not an error: the project page says "Setup needed" (HubSource.setupNeeded); releases wait unseen.
  if (needsInstall(p)) { res.skipped.push(`${rel.tag} (setup needed: games and install type)`); return 'choice'; }
  const version = versionOf(rel.tag);
  if (!validVersion(version)) {
    await markSeen(ctx, s.id, rel.tag, 'skipped');
    res.skipped.push(`${rel.tag} (not a version number)`);
    return 'skipped';
  }
  const { asset, candidates } = pickAsset(rel.assets, s.asset_pattern === ALL_ASSETS ? null : s.asset_pattern);
  // Browser add-on with one file per browser: all of them go into the one version (chosen as "[all]", or
  // automatically when every file names a browser).
  const perBrowser = candidates.filter((a) => browserLabel(a.name));
  if (p.type === 'browser-extension' && candidates.length > 1 && (s.asset_pattern === ALL_ASSETS || (!asset && perBrowser.length === candidates.length))) {
    const files = s.asset_pattern === ALL_ASSETS && perBrowser.length < candidates.length ? candidates : perBrowser;
    const [main, ...rest] = files;
    try {
      await ingestVersion(ctx, {
        project: p, fileName: main!.name, data: await downloadAsset(ctx, main!.url, ctx.cfg.MAX_UPLOAD_MB * 1048576), origin: `github:${s.target}@${rel.tag}`, uploaderId: null,
        meta: { version, channel: rel.prerelease ? 'beta' : 'stable', changelog: rel.body ?? '' },
        extraFiles: await Promise.all(rest.map(async (a) => ({ name: a.name, data: await downloadAsset(ctx, a.url, ctx.cfg.MAX_UPLOAD_MB * 1048576), label: browserLabel(a.name) }))),
      });
    } catch (e) {
      await markSeen(ctx, s.id, rel.tag, 'failed');
      res.skipped.push(`${rel.tag} (${(e as Error).message})`);
      return 'skipped';
    }
    if (s.asset_pattern !== ALL_ASSETS) await ctx.db.updateTable('sources').set({ asset_pattern: ALL_ASSETS }).where('id', '=', s.id).execute();
    await markSeen(ctx, s.id, rel.tag, 'imported');
    await ctx.db.updateTable('sources').set((eb) => ({ imported: eb('imported', '+', 1), needs_choice: null })).where('id', '=', s.id).execute();
    res.imported.push(version);
    return 'imported';
  }
  if (!asset) {
    if (!candidates.length) {
      await markSeen(ctx, s.id, rel.tag, 'skipped');
      res.skipped.push(`${rel.tag} (no zip or dll in the release)`);
      return 'skipped';
    }
    res.needsChoice = { tag: rel.tag, assets: candidates.map((a) => a.name) };
    await ctx.db.updateTable('sources').set({ needs_choice: JSON.stringify(res.needsChoice) }).where('id', '=', s.id).execute();
    return 'choice';
  }
  const data = await downloadAsset(ctx, asset.url, ctx.cfg.MAX_UPLOAD_MB * 1048576);
  try {
    await ingestVersion(ctx, {
      project: p, fileName: asset.name, data, origin: `github:${s.target}@${rel.tag}`, uploaderId: null,
      meta: { version, channel: rel.prerelease ? 'beta' : 'stable', changelog: rel.body ?? '' },
    });
  } catch (e) {
    await markSeen(ctx, s.id, rel.tag, 'failed');
    res.skipped.push(`${rel.tag} (${(e as Error).message})`);
    return 'skipped';
  }
  // Remember how the asset is named, so the next release is picked without asking.
  if (!s.asset_pattern) await ctx.db.updateTable('sources').set({ asset_pattern: patternFromName(asset.name) }).where('id', '=', s.id).execute();
  await markSeen(ctx, s.id, rel.tag, 'imported');
  await ctx.db.updateTable('sources').set((eb) => ({ imported: eb('imported', '+', 1), needs_choice: null })).where('id', '=', s.id).execute();
  res.imported.push(version);
  return 'imported';
}

/**
 * One source check. First check of a source imports only the newest release (and the newest beta,
 * when it is newer); later checks import every release not seen yet, oldest first.
 */
export async function checkSource(ctx: Ctx, sourceId: string, opts: { force?: boolean } = {}): Promise<CheckResult> {
  const res: CheckResult = { imported: [], skipped: [], needsChoice: null, unchanged: false, error: null };
  const s = await ctx.db.selectFrom('sources').selectAll().where('id', '=', sourceId).executeTakeFirst();
  if (!s) throw new Error('source not found');
  let p = await ctx.db.selectFrom('projects').selectAll().where('id', '=', s.project_id).executeTakeFirstOrThrow();
  const now = nowIso();
  let hadRelease = false;
  try {
    if (p.state === 'removed') throw new Error('project removed');
    if (s.kind === 'github') {
      // The repository's public face first (a release problem below must not keep it out). Claimed projects take
      // name, summary, icon, pictures and games from it; unclaimed ones only the showcase page.
      if (p.claimed) {
        const sync = await syncFromRepo(ctx, p, s.target, { force: !!opts.force }).catch(() => null);
        if (sync?.changed.length) p = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
      } else await refreshRepoShowcase(ctx, p, s.target).catch(() => 'skipped');
      const r = await getReleases(ctx, s.target, opts.force ? null : s.etag);
      if (r.status === 404) throw new Error('repository not found (deleted, renamed or private)');
      res.unchanged = r.status === 304;
      if (!res.unchanged) await setKv(ctx, `srcrel.${s.id}`, String(r.releases.length));
      if (!res.unchanged) {
        // First check, or a source that never imported or saw anything (its releases waited for the setup): only the newest ones come in.
        const first = !s.last_check || (s.imported === 0 && !(await ctx.db.selectFrom('source_seen').select('ref').where('source_id', '=', s.id).executeTakeFirst()));
        let todo = [];
        for (const rel of r.releases) if (!(await seen(ctx, s.id, rel.tag))) todo.push(rel);
        if (first) {
          // GitHub lists by creation date, which is not always the version order: the highest version counts as newest.
          const byVersion = [...todo].sort((x, y) => compareVersions(versionOf(y.tag), versionOf(x.tag)));
          const stable = byVersion.find((x) => !x.prerelease);
          const beta = byVersion.find((x) => x.prerelease);
          const keep = [stable, beta && (!stable || compareVersions(versionOf(beta.tag), versionOf(stable.tag)) > 0) ? beta : undefined].filter(Boolean) as GhRelease[];
          for (const x of todo) if (!keep.includes(x)) await markSeen(ctx, s.id, x.tag, 'skipped');
          todo = keep;
        }
        // Games and install type from the repository and the release file, so releases do not wait for a form.
        if (needsInstall(p) && r.releases.length) p = await autoSetup(ctx, p, s, r.releases).catch(() => p);
        for (const rel of todo.reverse()) {
          const out = await importGithubRelease(ctx, s, p, rel, res);
          if (out === 'choice') break;
        }
        hadRelease = r.releases.some((x) => x.published && Date.now() - Date.parse(x.published) < 60 * 86400_000);
        await ctx.db.updateTable('sources').set({ etag: res.needsChoice || needsInstall(p) ? null : r.etag }).where('id', '=', s.id).execute();
      }
      // GitHub's download counts of the release files, at most once a day (or on "Check now").
      await refreshGithubDownloads(ctx, p, s.target, !!opts.force).catch(() => undefined);
    } else {
      const r = await fetchTmlIndex(ctx, s.target, opts.force ? null : s.etag);
      res.unchanged = r.status === 304;
      if (r.index) {
        const prod = r.index.products?.[s.product ?? ''];
        if (!prod) throw new Error(`product ${s.product} is not in ${s.target}index.json`);
        const versions = Object.entries(prod.versions ?? {}).sort((a, b) => compareVersions(a[0], b[0]));
        const fresh = [];
        for (const [v, d] of versions) if (!(await seen(ctx, s.id, v))) fresh.push([v, d] as const);
        const todo = !s.last_check ? fresh.slice(-1) : fresh;
        if (!s.last_check) for (const [v] of fresh.slice(0, -1)) await markSeen(ctx, s.id, v, 'skipped');
        for (const [v, d] of todo) {
          if (!d.download_link || !/^https:\/\//i.test(d.download_link) || !validVersion(v)) {
            await markSeen(ctx, s.id, v, 'skipped');
            res.skipped.push(`${v} (no https download)`);
            continue;
          }
          try {
            const data = await downloadAsset(ctx, d.download_link, ctx.cfg.MAX_UPLOAD_MB * 1048576);
            await ingestVersion(ctx, {
              project: p, fileName: d.download_link.split(/[?#]/)[0].split('/').pop() || `${v}.zip`, data, origin: `tmloader:${s.target}#${s.product}@${v}`, uploaderId: null,
              upstreamSha256: d.hash_sha256 ?? null, meta: { version: v, channel: 'stable', changelog: d.changelog ?? '' },
              tmloader: { executable: d.executable ?? null, dependencies: (d.dependencies ?? []).map((x) => ({ id: x.id, version: x.version ?? null })), priority: d.priority ?? null },
            });
            await markSeen(ctx, s.id, v, 'imported');
            await ctx.db.updateTable('sources').set((eb) => ({ imported: eb('imported', '+', 1) })).where('id', '=', s.id).execute();
            res.imported.push(v);
            hadRelease = true;
          } catch (e) {
            await markSeen(ctx, s.id, v, 'failed');
            res.skipped.push(`${v} (${(e as Error).message})`);
          }
        }
        await ctx.db.updateTable('sources').set({ etag: r.etag }).where('id', '=', s.id).execute();
      }
    }
    const quiet = res.imported.length || hadRelease ? 0 : s.quiet_checks + 1;
    const interval = quiet === 0 || (s.quiet_checks < 3 && hadRelease) ? ctx.cfg.CRAWL_ACTIVE_MIN : ctx.cfg.CRAWL_QUIET_MIN;
    await ctx.db.updateTable('sources').set({ last_check: now, next_check: addMinutes(now, interval), last_error: null, quiet_checks: quiet }).where('id', '=', s.id).execute();
  } catch (e) {
    res.error = (e as Error).message;
    const backoff = Math.min(24 * 60, Math.max(ctx.cfg.CRAWL_ACTIVE_MIN, (s.last_error ? 2 : 1) * ctx.cfg.CRAWL_QUIET_MIN));
    await ctx.db.updateTable('sources').set({ last_check: now, next_check: addMinutes(now, backoff), last_error: res.error.slice(0, 300) }).where('id', '=', s.id).execute();
    if (!s.last_error) await ctx.notify({ kind: 'source-error', text: `Source ${s.target} of ${p.name}: ${res.error}` });
  }
  return res;
}

/** The author picked the asset for an ambiguous release: remember the pattern and import it. */
/** asset_pattern of a browser add-on that takes every file of a release (one per browser) into one version. */
export const ALL_ASSETS = '[all]';

export async function chooseAsset(ctx: Ctx, sourceId: string, tag: string, assetName: string): Promise<CheckResult> {
  const s = await ctx.db.selectFrom('sources').selectAll().where('id', '=', sourceId).executeTakeFirstOrThrow();
  const pattern = assetName === ALL_ASSETS ? ALL_ASSETS : patternFromName(assetName);
  if (pattern !== ALL_ASSETS && !globMatch(pattern, assetName)) throw new Error('bad asset name');
  await ctx.db.updateTable('sources').set({ asset_pattern: pattern, needs_choice: null }).where('id', '=', s.id).execute();
  await ctx.db.deleteFrom('source_seen').where('source_id', '=', s.id).where('ref', '=', tag).execute();
  return checkSource(ctx, sourceId, { force: true });
}

export async function addSource(ctx: Ctx, projectId: string, kind: 'github' | 'tmloader', target: string, product: string | null, assetPattern: string | null): Promise<string> {
  const dup = await ctx.db.selectFrom('sources').select('id').where('project_id', '=', projectId).where('kind', '=', kind).where('target', '=', target).executeTakeFirst();
  if (dup) return dup.id;
  const id = newId('s');
  await ctx.db.insertInto('sources').values({
    id, project_id: projectId, kind, target, product, asset_pattern: assetPattern, etag: null, last_check: null, next_check: nowIso(), last_error: null, imported: 0,
    needs_choice: null, webhook: 0, quiet_checks: 0, created_at: nowIso(),
  }).execute();
  return id;
}

/** Runs due checks (a few per tick, so a big backlog does not burst the GitHub budget). */
export async function crawlTick(ctx: Ctx, max = 5): Promise<number> {
  const due = await ctx.db.selectFrom('sources').select('id').where('next_check', '<=', nowIso()).orderBy('next_check').limit(max).execute();
  for (const s of due) await checkSource(ctx, s.id).catch((e) => console.error('[hub] crawl', s.id, e));
  return due.length;
}

/** GitHub App webhook: a release was published in these repositories; check them now. */
export async function onGithubRelease(ctx: Ctx, repo: string): Promise<number> {
  const list = await ctx.db.selectFrom('sources').select('id').where('kind', '=', 'github').where('target', '=', repo).execute();
  for (const s of list) await ctx.db.updateTable('sources').set({ next_check: nowIso(), webhook: 1 }).where('id', '=', s.id).execute();
  return list.length;
}

export const needsChoiceOf = (s: SourcesTable) => parseJson<{ tag: string; assets: string[] } | null>(s.needs_choice, null);
