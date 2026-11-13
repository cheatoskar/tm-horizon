// Builds src/data/github-projects.json for the page "All TrackMania projects on GitHub" (/discover/github/).
// Sources, merged by repository:
//   1. the hub's discovered and accepted repositories: GET <HUB_URL>/v1/github-projects (HUB_URL env, e.g. http://localhost:8787;
//      without it the hub part is skipped and the page shows the catalog's repositories only),
//   2. the GitHub projects of the catalog that build-data.mjs already put into src/data/site.json (run it first).
// A hub that cannot be reached never fails the build: the page then has what the catalog knows.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.join(root, 'src', 'data', 'github-projects.json');
const hub = (process.env.HUB_URL || process.env.PUBLIC_HUB_URL || '').replace(/\/+$/, '');

const items = new Map();
const sources = { hub: null, catalog: 0 };

try {
  const site = JSON.parse(fs.readFileSync(path.join(root, 'src', 'data', 'site.json'), 'utf8'));
  for (const p of site.projects ?? []) {
    items.set(String(p.repo).toLowerCase(), {
      repo: p.repo, name: p.name, description: p.description ?? null, url: p.url, stars: p.stars ?? 0, language: p.language ?? null, games: p.games ?? [],
      pushed: p.pushed ?? null, archived: !!p.archived, topics: [], from: 'catalog',
    });
  }
  sources.catalog = items.size;
} catch { /* no site.json yet */ }

if (hub) {
  try {
    let page = 1;
    let total = 0;
    for (;;) {
      const r = await fetch(`${hub}/v1/github-projects?limit=200&page=${page}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      for (const p of j.items) items.set(p.repo.toLowerCase(), { ...items.get(p.repo.toLowerCase()), ...p, name: items.get(p.repo.toLowerCase())?.name ?? p.name, from: 'hub' });
      total = j.total;
      if (page * 200 >= total || page >= 25) break;
      page++;
    }
    sources.hub = { url: hub, count: total };
  } catch (e) {
    console.warn(`github-projects: hub ${hub} not used (${e.message})`);
  }
}

const list = [...items.values()].sort((a, b) => (b.pushed ?? '').localeCompare(a.pushed ?? '') || a.repo.localeCompare(b.repo));
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), sources, items: list }, null, 1));
console.log(`github-projects: ${list.length} repositories (catalog ${sources.catalog}, hub ${sources.hub?.count ?? 'off'})`);
