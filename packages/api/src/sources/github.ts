// GitHub projects: repository facts and the newest release.
// Two requests per repository: GET /repos/{owner}/{repo} and GET /repos/{owner}/{repo}/releases?per_page=10.
// Without GITHUB_TOKEN the limit is 60 requests per hour and IP; responses are cached
// (ttl + ETag) and the source stops asking when the remaining budget gets low.
import type { CatalogEntry, GameId, Project, ProjectRelease, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { HttpError } from '../lib/http.ts';
import { errorText, isGameId, shorten } from '../lib/util.ts';

export interface GhRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id?: string | null; name?: string | null } | null;
  topics?: string[];
  archived: boolean;
  pushed_at: string | null;
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  body: string | null;
  assets: { name: string; size: number; browser_download_url: string; download_count: number; content_type?: string | null }[];
}

const GH_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/;

/** "owner/repo" from a GitHub URL, else null. */
export function githubRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = GH_RE.exec(url.trim());
  if (!m) return null;
  if (['orgs', 'topics', 'sponsors', 'settings', 'features'].includes(m[1].toLowerCase())) return null;
  return `${m[1]}/${m[2]}`;
}

/** Newest non-draft release; a stable one wins over newer prereleases only if it is in the list. */
export function pickRelease(releases: GhRelease[]): GhRelease | null {
  const real = releases.filter((r) => !r.draft);
  return real.find((r) => !r.prerelease) ?? real[0] ?? null;
}

export function parseProject(repo: GhRepo, releases: GhRelease[], catalogIds: string[], games: GameId[]): Project {
  const r = pickRelease(releases);
  const release: ProjectRelease | null = r
    ? {
        tag: r.tag_name,
        name: r.name || null,
        published: r.published_at,
        prerelease: r.prerelease,
        url: r.html_url,
        notes: shorten(r.body?.trim(), 4000),
        assets: r.assets.map((a) => ({
          name: a.name,
          size: a.size,
          download: a.browser_download_url,
          downloads: a.download_count,
          contentType: a.content_type ?? null,
        })),
      }
    : null;
  return {
    id: repo.full_name,
    name: repo.name,
    description: repo.description,
    url: repo.html_url,
    homepage: repo.homepage || null,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    language: repo.language,
    license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : (repo.license?.name ?? null),
    topics: repo.topics ?? [],
    archived: repo.archived,
    pushed: repo.pushed_at,
    release,
    catalogIds,
    games,
  };
}

/** Repositories to look at: GitHub links in the catalog plus the configured list. */
export function collectRepos(catalog: CatalogEntry[], extra: string[]): { repo: string; catalogIds: string[]; games: GameId[] }[] {
  const map = new Map<string, { repo: string; catalogIds: string[]; games: GameId[] }>();
  const touch = (repo: string) => {
    const key = repo.toLowerCase();
    let e = map.get(key);
    if (!e) map.set(key, (e = { repo, catalogIds: [], games: [] }));
    return e;
  };
  for (const r of extra) touch(r);
  for (const c of catalog) {
    if (!c.github) continue;
    const e = touch(c.github);
    e.catalogIds.push(c.id);
    for (const g of c.games) if (isGameId(g) && !e.games.includes(g)) e.games.push(g);
  }
  return [...map.values()];
}

export async function buildProjects(ctx: SourceContext, catalog: CatalogEntry[]): Promise<{ projects: Project[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.github;
  const token = ctx.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ttl = token ? cfg.ttlMinutesToken : cfg.ttlMinutesAnonymous;
  const repos = collectRepos(catalog, cfg.repos);
  const projects: Project[] = [];
  let remaining = Infinity;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let fromCache = 0;

  const get = async <T>(url: string): Promise<T | null> => {
    const low = remaining < cfg.minRemaining;
    // Budget low: cached copies only, however old.
    if (low && !ctx.http.index[url]) return null;
    const { data, result } = await ctx.http.getJson<T>(url, { headers, ttlMinutes: low ? 1e9 : ttl });
    const rem = Number(result.headers['x-ratelimit-remaining']);
    if (!result.cache || result.cache === 'revalidated') {
      if (Number.isFinite(rem)) remaining = rem;
    } else fromCache++;
    return data;
  };

  for (const r of repos) {
    try {
      const repo = await get<GhRepo>(`https://api.github.com/repos/${r.repo}`);
      if (!repo) {
        skipped++;
        continue;
      }
      // Renamed or moved repositories redirect; two catalog links can end at the same repository.
      const same = projects.find((p) => p.id.toLowerCase() === repo.full_name.toLowerCase());
      if (same) {
        for (const id of r.catalogIds) if (!same.catalogIds.includes(id)) same.catalogIds.push(id);
        for (const g of r.games) if (!same.games.includes(g)) same.games.push(g);
        continue;
      }
      const releases = (await get<GhRelease[]>(`https://api.github.com/repos/${repo.full_name}/releases?per_page=10`)) ?? [];
      projects.push(parseProject(repo, releases, r.catalogIds, r.games));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        missing++;
        ctx.warn(`github: ${r.repo} not found`);
      } else {
        failed++;
        ctx.warn(`github: ${r.repo}: ${errorText(e)}`);
      }
    }
  }
  if (skipped) ctx.warn(`github: rate limit low, ${skipped} repositories skipped (set GITHUB_TOKEN)`);
  projects.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
  const status: SourceStatus = {
    id: 'github',
    ok: projects.length > 0 || repos.length === 0,
    count: projects.length,
    sample: false,
    cached: fromCache > 0,
  };
  if (failed || skipped || missing) status.error = `${missing} not found, ${failed} failed, ${skipped} skipped (rate limit)`;
  return { projects, sources: [status] };
}
