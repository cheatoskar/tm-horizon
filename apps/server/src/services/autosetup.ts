// "Setup needed" without asking: a project from a GitHub repository with games and an install type can take its
// releases. The repository usually tells both: the games from showcase.json (compat block), the install type from the
// release file itself (a zip with <Product>/<version>/description.yaml is a TMLoader product; a zip with loader or
// plugin files (dll, asi, exe) is copied next to the game). What cannot be derived stays "Setup needed", with a
// one-line reason the portal shows (kv key autosetup.<source id>).
import { HUB_GAMES, installOfType, type GameId, type HubInstall, type HubInstallType, type HubProjectType, PROJECT_TYPES } from '@tm-hub/shared';
import { validateShowcase } from '@tm-hub/shared/showcase';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable, SourcesTable } from '../db/db.ts';
import { downloadAsset, pickAsset, type GhRelease } from '../sources/github.ts';
import { readEntries } from '../checks/zip.ts';
import { nowIso, parseJson } from '../util.ts';
import { needsInstall } from './projects.ts';
import { readRepoShowcase, showcaseOptions } from './showcase.ts';
import { compatGames } from './repo-sync.ts';

const reasonKey = (sourceId: string) => `autosetup.${sourceId}`;

async function setReason(ctx: Ctx, sourceId: string, reason: string | null) {
  await ctx.db.deleteFrom('kv').where('key', '=', reasonKey(sourceId)).execute();
  if (reason) await ctx.db.insertInto('kv').values({ key: reasonKey(sourceId), value: reason }).execute();
}

/** The install type a release zip tells: TMLoader product layout, or program files for the game folder. null = cannot tell. */
export function installFromZip(names: string[]): { type: HubInstallType; why: string } | null {
  const files = names.filter((n) => !n.endsWith('/'));
  if (files.some((n) => /^[^/]+\/[^/]+\/description\.yaml$/i.test(n) || /^[^/]+\/description\.yaml$/i.test(n))) return { type: 'tmloader-product', why: 'zip holds a TMLoader product (description.yaml)' };
  if (files.some((n) => /\.(dll|asi)$/i.test(n))) return { type: 'files:game', why: 'zip holds dll/asi files for the game folder' };
  return null;
}

/** Derives games and install type for a project that needs them. Returns the project (updated when it worked). */
export async function autoSetup(ctx: Ctx, p: ProjectsTable, s: SourcesTable, releases: GhRelease[]): Promise<ProjectsTable> {
  if (!needsInstall(p)) { await setReason(ctx, s.id, null); return p; }
  const delivery = p.type && p.type in PROJECT_TYPES ? PROJECT_TYPES[p.type as HubProjectType].delivery : 'game';
  if (delivery !== 'game' && delivery !== 'files') return p;
  const fail = async (reason: string) => { await setReason(ctx, s.id, reason); return p; };
  // games: what the project has, else the showcase compat block
  let games = parseJson<GameId[]>(p.games, []).filter((g) => HUB_GAMES.includes(g));
  if (!games.length) {
    const raw = await readRepoShowcase(ctx, s.target, 'HEAD').catch(() => null);
    const v = raw ? validateShowcase(raw, showcaseOptions(ctx)).showcase : null;
    games = v ? compatGames(v) : [];
  }
  if (!games.length) return fail('Games missing: no compat block in showcase.json. Choose the games.');
  // install type: from the newest stable release file (else the newest)
  const rel = releases.find((r) => !r.prerelease && !r.draft) ?? releases[0];
  if (!rel) return fail('No release yet.');
  const { asset, candidates } = pickAsset(rel.assets, s.asset_pattern === '[all]' ? null : s.asset_pattern);
  const pick = asset ?? candidates.find((a) => /\.zip$/i.test(a.name));
  if (!pick) return fail(`Install type missing: ${rel.tag} has no zip to look into. Choose how it installs.`);
  if (!/\.zip$/i.test(pick.name)) return fail(`Install type missing: ${pick.name} is not a zip. Choose how it installs.`);
  let names: string[];
  try { names = readEntries(await downloadAsset(ctx, pick.url, ctx.cfg.MAX_UPLOAD_MB * 1048576)).map((e) => e.name); }
  catch (e) { return fail(`Install type missing: could not read ${pick.name} (${(e as Error).message}). Choose how it installs.`); }
  const found = installFromZip(names);
  if (!found) return fail(`Install type missing: ${pick.name} has no TMLoader product and no dll/asi files. Choose how it installs.`);
  const install: HubInstall = installOfType(found.type);
  const installs = Object.fromEntries(games.map((g) => [g, install]));
  await ctx.db.updateTable('projects').set({ games: JSON.stringify(games), installs: JSON.stringify(installs), updated_at: nowIso() }).where('id', '=', p.id).execute();
  await ctx.audit('system', 'project.auto-setup', p.id, { repo: s.target, release: rel.tag, asset: pick.name, install: found.type, why: found.why, games });
  await setReason(ctx, s.id, null);
  return { ...p, games: JSON.stringify(games), installs: JSON.stringify(installs) };
}
