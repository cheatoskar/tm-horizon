// GitHub as a connected source: the hub reads public releases itself with its own token (one shared
// rate-limit budget, conditional requests with ETag so unchanged repositories cost nothing), picks the
// release asset on its own and remembers the pattern, and takes changelog and screenshots from the
// release notes and the README. Authors only paste the repository URL.
import type { Ctx } from '../ctx.ts';
import { HttpError } from '../util.ts';

export interface GhAsset { name: string; size: number; url: string; contentType: string | null; downloads?: number }
export interface GhRelease { tag: string; name: string | null; body: string; prerelease: boolean; draft: boolean; published: string | null; assets: GhAsset[] }
export interface GhRepo { fullName: string; name: string; description: string | null; homepage: string | null; license: string | null; owner: string; htmlUrl: string; topics: string[]; archived: boolean; defaultBranch: string }

/** "owner/repo" from a GitHub URL or "owner/repo" text; null when it is not one. */
export function parseGithubRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(s) ?? /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Shared budget: when GitHub says few requests are left, every source waits for the reset. */
export const budget = { remaining: 5000, reset: 0 };

export function githubHeaders(ctx: Ctx, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)',
    ...(ctx.cfg.GITHUB_TOKEN ? { authorization: `Bearer ${ctx.cfg.GITHUB_TOKEN}` } : {}), ...extra,
  };
}

async function gh(ctx: Ctx, path: string, etag?: string | null): Promise<{ status: number; json: unknown; etag: string | null; text?: string }> {
  // Keep a reserve for "Check now" and previews; without a token GitHub allows only 60 requests an hour.
  const floor = ctx.cfg.GITHUB_TOKEN ? 50 : 3;
  if (budget.remaining < floor && Date.now() < budget.reset) throw new HttpError(503, 'github_rate_limit', `GitHub rate limit reached; try again after ${new Date(budget.reset).toISOString().slice(11, 16)} UTC`);
  const r = await ctx.fetch(`https://api.github.com${path}`, { headers: githubHeaders(ctx, etag ? { 'if-none-match': etag } : {}) });
  const rem = r.headers.get('x-ratelimit-remaining');
  const reset = r.headers.get('x-ratelimit-reset');
  if (rem) budget.remaining = Number(rem);
  if (reset) budget.reset = Number(reset) * 1000;
  if (r.status === 304) return { status: 304, json: null, etag: etag ?? null };
  if (r.status === 404) return { status: 404, json: null, etag: null };
  if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
  return { status: r.status, json: await r.json(), etag: r.headers.get('etag') };
}

export async function getRepo(ctx: Ctx, repo: string): Promise<GhRepo | null> {
  const r = await gh(ctx, `/repos/${repo}`);
  if (r.status === 404) return null;
  const j = r.json as Record<string, any>;
  return {
    fullName: j.full_name, name: j.name, description: j.description ?? null, homepage: j.homepage || null, license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null,
    owner: j.owner?.login ?? repo.split('/')[0], htmlUrl: j.html_url, topics: j.topics ?? [], archived: !!j.archived, defaultBranch: j.default_branch ?? 'main',
  };
}

/** Newest releases (drafts left out). status 304 = unchanged since `etag`. */
export async function getReleases(ctx: Ctx, repo: string, etag?: string | null): Promise<{ status: number; etag: string | null; releases: GhRelease[] }> {
  const r = await gh(ctx, `/repos/${repo}/releases?per_page=10`, etag);
  if (r.status === 304 || r.status === 404) return { status: r.status, etag: r.etag, releases: [] };
  const list = (r.json as Record<string, any>[]).filter((x) => !x.draft).map((x): GhRelease => ({
    tag: x.tag_name, name: x.name ?? null, body: (x.body ?? '').slice(0, 20_000), prerelease: !!x.prerelease, draft: false, published: x.published_at ?? null,
    assets: (x.assets ?? []).map((a: Record<string, any>) => ({ name: a.name, size: a.size, url: a.browser_download_url, contentType: a.content_type ?? null, downloads: Number(a.download_count) || 0 })),
  }));
  return { status: r.status, etag: r.etag, releases: list };
}

export type ImageFrom = 'readme' | 'release' | 'docs';

/** Pictures in a README (Markdown and <img>) as https URLs; badges and SVGs left out. */
export function imagesInMarkdown(md: string, repo: string, branch: string): string[] {
  const out: string[] = [];
  const raw = (p: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${p.replace(/^\.?\//, '')}`;
  const add = (u: string) => {
    u = u.trim().replace(/^<|>$/g, '');
    if (/shields\.io|badge|\.svg(\?|$)/i.test(u)) return;
    if (/^https:\/\//i.test(u)) out.push(u.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/'));
    else if (!/^[a-z]+:/i.test(u) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) out.push(raw(u));
  };
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) add(m[1]);
  for (const m of md.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return [...new Set(out)];
}

/** Discord invite in a README (discord.gg/... or discord.com/invite/...), as https URL. */
export function discordInMarkdown(md: string): string | null {
  const m = /https?:\/\/(?:www\.)?(discord\.gg\/[A-Za-z0-9-]{2,32}|discord(?:app)?\.com\/invite\/[A-Za-z0-9-]{2,32})/i.exec(md);
  return m ? `https://${m[1]}` : null;
}

/** Screenshots from the README text, the release files and docs/images, each with where it was found; at most 12. */
export async function repoImages(ctx: Ctx, repo: string, branch: string, readmeText: string, release: GhRelease | null): Promise<{ url: string; from: ImageFrom }[]> {
  const out: { url: string; from: ImageFrom }[] = imagesInMarkdown(readmeText, repo, branch).map((url) => ({ url, from: 'readme' }));
  for (const a of release?.assets ?? []) if (/\.(png|jpe?g|webp|gif)$/i.test(a.name) && /^https:\/\//i.test(a.url)) out.push({ url: a.url, from: 'release' });
  try {
    const r = await gh(ctx, `/repos/${repo}/contents/docs/images`);
    const raw = (p: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${p}`;
    if (r.status === 200 && Array.isArray(r.json)) for (const f of r.json as { name: string; path: string; type: string }[]) if (f.type === 'file' && /\.(png|jpe?g|webp)$/i.test(f.name)) out.push({ url: raw(f.path), from: 'docs' });
  } catch { /* no docs/images */ }
  const seen = new Set<string>();
  return out.filter((x) => !seen.has(x.url) && !!seen.add(x.url)).slice(0, 12);
}

/** Sum of GitHub's download counts over the installable files of all releases (up to 300 releases, 3 requests). */
export async function githubDownloadTotal(ctx: Ctx, repo: string): Promise<number> {
  let total = 0;
  for (let page = 1; page <= 3; page++) {
    const r = await gh(ctx, `/repos/${repo}/releases?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) break;
    const list = r.json as { draft?: boolean; assets?: { name: string; download_count?: number }[] }[];
    for (const rel of list) if (!rel.draft) for (const a of rel.assets ?? []) if (countsAsDownload(a.name)) total += Number(a.download_count) || 0;
    if (list.length < 100) break;
  }
  return total;
}

const SKIP = /(source|src|debug|symbols|\.pdb|\.sig|\.asc|sha256|checksums?)/i;
const INSTALLABLE = /\.(zip|dll)$/i;
/** Files players download (counted for "Downloads"): what the hub could install, plus browser extension packages. */
export const countsAsDownload = (name: string) => /\.(zip|dll|xpi|crx|exe|7z)$/i.test(name) && !SKIP.test(name);

/** Glob pattern ("*" only) from an asset name: version numbers become "*". */
export function patternFromName(name: string): string {
  return name.replace(/v?\d+(?:[._-]\d+)+(?:[-.]?(?:alpha|beta|rc|pre)[.-]?\d*)?/gi, '*').replace(/\*+/g, '*');
}

export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(name);
}

/** The asset to copy: by the remembered pattern, else the only installable one. Several candidates = ask the author. */
export function pickAsset(assets: GhAsset[], pattern: string | null): { asset: GhAsset | null; candidates: GhAsset[] } {
  const cands = assets.filter((a) => INSTALLABLE.test(a.name) && !SKIP.test(a.name));
  if (pattern) {
    const hit = cands.filter((a) => globMatch(pattern, a.name));
    if (hit.length === 1) return { asset: hit[0], candidates: cands };
    if (hit.length > 1) return { asset: null, candidates: hit };
  }
  if (cands.length === 1) return { asset: cands[0], candidates: cands };
  // A zip and a DLL of the same mod: the zip is the complete package.
  const zips = cands.filter((a) => /\.zip$/i.test(a.name));
  if (zips.length === 1 && cands.every((a) => a === zips[0] || /\.dll$/i.test(a.name))) return { asset: zips[0], candidates: cands };
  return { asset: null, candidates: cands };
}

/** Downloads a release asset (https only, size cap, follows GitHub's redirect to its CDN). */
export async function downloadAsset(ctx: Ctx, url: string, maxBytes: number): Promise<Buffer> {
  if (!/^https:\/\//i.test(url)) throw new Error('only https downloads');
  const r = await ctx.fetch(url, { headers: { 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)', accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  if (r.url && !/^https:\/\//i.test(r.url)) throw new Error('download redirected to http');
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('file too large');
  const reader = r.body?.getReader();
  if (!reader) return Buffer.from(await r.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('file too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Does this GitHub user (OAuth token, used once and dropped) have admin rights on the repository? */
export async function isRepoAdmin(ctx: Ctx, repo: string, userToken: string): Promise<boolean> {
  const r = await ctx.fetch(`https://api.github.com/repos/${repo}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${userToken}`, 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)' } });
  if (!r.ok) return false;
  const j = (await r.json()) as { permissions?: { admin?: boolean } };
  return !!j.permissions?.admin;
}
