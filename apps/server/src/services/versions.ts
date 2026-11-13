// Versions: every file becomes an immutable hub copy (content-addressed by SHA-256), runs through
// the checks, then: rejected / review (new project or flagged) / held (clean update, goes live after
// HOLD_MINUTES unless the author cancels) -> published. Revoked versions go into the signed index's
// revocation list so launchers refuse or remove them.
import { z } from 'zod';
import type { CheckReport, GameId, HubInstall, HubInstallType, HubVersion, StatementOfReasons, VersionStatus } from '@tm-hub/shared';
import { typeOfInstall } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import type { ExtraFile, ProjectsTable, VersionsTable } from '../db/db.ts';
import { runChecks, sha256 } from '../checks/pipeline.ts';
import { dinput8Allowed } from '../checks/dinput8.ts';
import { isZip, unzipAll } from '../checks/zip.ts';
import { isPe } from '../checks/pe.ts';
import { wrapTmloader } from '../checks/zipwrite.ts';
import { verifyAuthorSignature } from '../index/sign.ts';
import { storageName } from '../storage.ts';
import { HttpError, addMinutes, compareVersions, newId, nowIso, parseJson } from '../util.ts';
import { installsSchema } from './projects.ts';
import { rebuildIndex } from './hubindex.ts';

export const versionMetaSchema = z.object({
  version: z.string().trim().regex(/^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$/, 'Use a version like 1.2.0 or 1.2.0-beta.1'),
  channel: z.enum(['stable', 'beta']).default('stable'),
  changelog: z.string().max(20_000).default(''),
  /** Defaults to the project's installs. */
  installs: installsSchema.refine((r) => Object.keys(r).length > 0, 'choose at least one game').optional(),
  signature: z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), sig: z.string().max(200) }).nullable().optional(),
});
export type VersionMeta = z.infer<typeof versionMetaSchema>;

export interface IngestInput {
  project: ProjectsTable;
  fileName: string;
  data: Buffer;
  meta: VersionMeta;
  origin: string;
  uploaderId: string | null;
  /** SHA-256 the source states for the original file (TMLoader index); checked when set. */
  upstreamSha256?: string | null;
  /** For TMLoader server zips: executable, dependencies, priority from the index. */
  tmloader?: { executable: string | null; dependencies: { id: string; version: string | null }[]; priority?: number | null } | null;
  /** Browser add-ons: the other files of the release (one per browser), checked like the main file. */
  extraFiles?: { name: string; data: Buffer; label: string | null }[];
}

/** Browser of a file name ("TMX-Downloader-2.7.1-firefox.zip" -> "firefox"), or null. */
export const browserLabel = (name: string): string | null => /chrome|chromium/i.test(name) ? 'chrome' : /firefox|mozilla/i.test(name) ? 'firefox' : /edge/i.test(name) ? 'edge' : /opera/i.test(name) ? 'opera' : null;

/** All files of a version: the main one and the extra ones (browser add-ons), with their download links. */
export function filesOf(ctx: Ctx, v: Pick<VersionsTable, 'id' | 'file_name' | 'file_size' | 'file_sha256' | 'extra_files' | 'installs'>, label?: string | null) {
  const extras = parseJson<ExtraFile[]>(v.extra_files ?? null, []);
  const main = { name: v.file_name, size: v.file_size, sha256: v.file_sha256, url: `${ctx.cfg.HUB_PUBLIC_URL}dl/${v.id}/${v.file_name}`, ...(extras.length && (label ?? browserLabel(v.file_name)) ? { label: (label ?? browserLabel(v.file_name))! } : {}) };
  return [main, ...extras.map((x) => ({ name: x.name, size: x.size, sha256: x.sha256, url: `${ctx.cfg.HUB_PUBLIC_URL}dl/${v.id}/${x.name}`, ...(x.label ? { label: x.label } : {}) }))];
}

const statement = (s: Omit<StatementOfReasons, 'decidedAt'>): StatementOfReasons => ({ ...s, decidedAt: nowIso() });
// The portal has no appeal button yet, so the statement names the e-mail route only (Nutzungsbedingungen § 5 Nr. 5).
export const REDRESS = 'Du kannst innerhalb von 6 Monaten per E-Mail an die im Impressum genannte Adresse Widerspruch einlegen; ein Mensch prüft den Fall erneut, der Rechtsweg bleibt offen. / You can appeal within 6 months by e-mail to the address in the imprint; a person reviews the case again, courts remain open.';

/** A DLL-only upload or a TMLoader server zip (files at the root) wrapped into <Product>/<version>/. */
function maybeWrap(input: IngestInput, installs: Partial<Record<GameId, HubInstall>>, version: string): { name: string; data: Buffer; wrapped: boolean } {
  const wantsTml = Object.values(installs).some((i) => i?.kind === 'tmloader-product');
  if (!wantsTml) return { name: input.fileName, data: input.data, wrapped: false };
  const product = input.project.tmloader_product;
  let files: { path: string; data: Buffer }[] | null = null;
  if (isPe(input.data) && /\.dll$/i.test(input.fileName)) files = [{ path: storageName(input.fileName), data: input.data }];
  else if (isZip(input.data)) {
    let inner: { path: string; data: Buffer }[] = [];
    try { inner = unzipAll(input.data).files.filter((f) => !f.path.includes('!/')); } catch { return { name: input.fileName, data: input.data, wrapped: false }; }
    const hasLayout = inner.some((f) => /^[^/]+\/[^/]+\/description\.yaml$/i.test(f.path));
    if (!hasLayout && input.tmloader) files = inner;
  }
  if (!files) return { name: input.fileName, data: input.data, wrapped: false };
  if (!product) throw new HttpError(400, 'tmloader_product_missing', 'Set the TMLoader product id of the project first (Project > Install)');
  const exe = input.tmloader?.executable ?? files.find((f) => /\.dll$/i.test(f.path))?.path.split('/').pop() ?? null;
  const p = input.project;
  const data = wrapTmloader({
    product, version, executable: exe, dependencies: input.tmloader?.dependencies ?? parseJson<{ id: string; version: string | null; tmloader?: boolean }[]>(p.dependencies, []).filter((d) => d.tmloader).map((d) => ({ id: d.id, version: d.version })),
    priority: input.tmloader?.priority ?? null, changelog: input.meta.changelog || null, name: p.name, author: p.author_name, description: p.summary,
    homepage: parseJson<{ homepage?: string }>(p.links, {}).homepage ?? null,
  }, files);
  return { name: `${p.slug}-${version}.zip`, data, wrapped: true };
}

export async function ingestVersion(ctx: Ctx, input: IngestInput): Promise<VersionsTable> {
  const p = input.project;
  if (p.state === 'removed') throw new HttpError(409, 'project_removed', 'This project was removed');
  const meta = versionMetaSchema.parse(input.meta);
  const version = meta.version.replace(/^v/i, '');
  if (await ctx.db.selectFrom('versions').select('id').where('project_id', '=', p.id).where('version', '=', version).executeTakeFirst()) {
    throw new HttpError(409, 'version_exists', `Version ${version} exists already; versions never change, publish a new one`);
  }
  // A browser extension is never installed into a game: its versions carry no installs (index: installs {}).
  const browser = p.type === 'browser-extension';
  const installs = (browser ? {} : meta.installs ?? parseJson<Partial<Record<GameId, HubInstall>>>(p.installs, {})) as Partial<Record<GameId, HubInstall>>;
  if (!browser && !Object.keys(installs).length) throw new HttpError(400, 'no_games', 'Choose the games and how it installs first');
  if (input.data.length > ctx.cfg.MAX_UPLOAD_MB * 1048576) throw new HttpError(413, 'too_large', `Files up to ${ctx.cfg.MAX_UPLOAD_MB} MB`);
  if (input.upstreamSha256 && sha256(input.data) !== input.upstreamSha256.toLowerCase()) {
    throw new HttpError(422, 'upstream_hash', 'The download does not match the SHA-256 its source lists');
  }

  const file = maybeWrap(input, installs, version);
  const hash = sha256(file.data);
  const fileName = storageName(file.name);

  // Previous published version for the diff.
  const prevRows = await ctx.db.selectFrom('versions').selectAll().where('project_id', '=', p.id).where('status', 'in', ['published', 'held']).execute();
  const prev = [...prevRows].sort((a, b) => compareVersions(a.version, b.version)).pop() ?? null;
  const published = prevRows.some((v) => v.status === 'published');

  // Author signature (over the hub copy's hash).
  let signature: { keyId: string; verified: boolean } | null = null;
  if (meta.signature) {
    const members = await ctx.db.selectFrom('members').select('user_id').where('project_id', '=', p.id).execute();
    const key = await ctx.db.selectFrom('author_keys').selectAll().where('key_id', '=', meta.signature.keyId).where('revoked_at', 'is', null).executeTakeFirst();
    const ok = !!key && members.some((m) => m.user_id === key.user_id) && verifyAuthorSignature(p.slug, version, hash, meta.signature.sig, key.public_key);
    signature = { keyId: meta.signature.keyId, verified: ok };
  }

  const types = Object.fromEntries(Object.entries(installs).map(([g, i]) => [g, typeOfInstall(i!)])) as Partial<Record<GameId, HubInstallType>>;
  const strip = Object.values(installs).find((i) => i?.kind === 'tmloader-product')?.strip ?? 0;
  const report: CheckReport = await runChecks({
    fileName, data: file.data, installs: types, projectType: p.type, strip, version, newProject: !published, uploaderId: input.uploaderId, origin: input.origin,
    previous: prev ? {
      report: parseJson<CheckReport>(prev.report, { verdict: 'clean', findings: [], files: [], pe: [], virusTotal: null, checkedAt: '' }),
      installTypes: Object.values(parseJson<Record<string, HubInstall>>(prev.installs, {})).map(typeOfInstall), uploaderId: prev.uploader_id,
      signatureKeyId: parseJson<{ keyId: string } | null>(prev.signature, null)?.keyId ?? null, size: prev.file_size, origin: prev.origin,
    } : null,
    ownerChangedRecently: !!p.owner_changed_at && Date.now() - Date.parse(p.owner_changed_at) < 14 * 86400_000,
    allowDinput8: dinput8Allowed(p, input.origin),
    signature, vt: ctx.vt, vtUpload: ctx.cfg.VT_UPLOAD, maxUpload: ctx.cfg.MAX_UPLOAD_MB * 1048576,
  });
  if (file.wrapped) report.findings.unshift({ severity: 'info', code: 'meta.wrapped', message: 'Wrapped into the TMLoader layout by the hub' });
  // Extra files (browser add-ons): the same checks each; the worst verdict counts for the whole version.
  const extras: { name: string; data: Buffer; label: string | null; hash: string }[] = [];
  for (const x of (browser ? input.extraFiles ?? [] : []).slice(0, 4)) {
    if (x.data.length > ctx.cfg.MAX_UPLOAD_MB * 1048576) throw new HttpError(413, 'too_large', `Files up to ${ctx.cfg.MAX_UPLOAD_MB} MB`);
    const name = storageName(x.name);
    if (name === fileName || extras.some((e) => e.name === name)) continue;
    const r = await runChecks({
      fileName: name, data: x.data, installs: {}, projectType: p.type, strip: 0, version, newProject: !published, uploaderId: input.uploaderId, origin: input.origin,
      previous: null, ownerChangedRecently: !!p.owner_changed_at && Date.now() - Date.parse(p.owner_changed_at) < 14 * 86400_000,
      signature: null, vt: ctx.vt, vtUpload: ctx.cfg.VT_UPLOAD, maxUpload: ctx.cfg.MAX_UPLOAD_MB * 1048576,
    });
    for (const f of r.findings) report.findings.push({ ...f, message: `${name}: ${f.message}` });
    if (r.verdict === 'rejected' || (r.verdict === 'flagged' && report.verdict === 'clean')) report.verdict = r.verdict;
    extras.push({ name, data: x.data, label: x.label, hash: sha256(x.data) });
  }

  const at = nowIso();
  let status: VersionStatus;
  let decision: StatementOfReasons | null = null;
  if (report.verdict === 'rejected') {
    status = 'rejected';
    const why = report.findings.filter((f) => f.severity === 'reject').map((f) => f.message).join('; ');
    decision = statement({ decision: 'reject-version', facts: `Automatic checks refused the file: ${why}`, ground: 'Nutzungsbedingungen § 4 (zulässige Inhalte, keine Schadsoftware) / Terms § 4', groundType: 'terms', automated: true, redress: REDRESS, decidedBy: 'automated checks' });
  } else if (report.verdict === 'flagged') status = 'review';
  else status = 'held';

  const storageKey = `files/${hash}/${fileName}`;
  if (status !== 'rejected') await ctx.storage.put(storageKey, file.data, isZip(file.data) ? 'application/zip' : 'application/octet-stream');
  const extraRows: ExtraFile[] = [];
  for (const x of extras) {
    const key = `files/${x.hash}/${x.name}`;
    if (status !== 'rejected') await ctx.storage.put(key, x.data, isZip(x.data) ? 'application/zip' : 'application/octet-stream');
    extraRows.push({ name: x.name, size: x.data.length, sha256: x.hash, storage_key: key, label: x.label });
  }
  const row: VersionsTable = {
    id: newId('v'), project_id: p.id, version, channel: meta.channel, changelog: meta.changelog, games: browser ? p.games : JSON.stringify(Object.keys(installs)), installs: JSON.stringify(installs),
    status, publish_at: status === 'held' ? addMinutes(at, ctx.cfg.HOLD_MINUTES) : null, published_at: null, origin: input.origin, uploader_id: input.uploaderId,
    signature: meta.signature ? JSON.stringify(meta.signature) : null, verified: signature?.verified ? 1 : 0, report: JSON.stringify(report),
    decision: decision ? JSON.stringify(decision) : null, file_name: fileName, file_size: file.data.length, file_sha256: hash, storage_key: storageKey, downloads: 0, created_at: at,
    extra_files: extraRows.length ? JSON.stringify(extraRows) : null,
  };
  await ctx.db.insertInto('versions').values(row).execute();
  await ctx.audit(input.uploaderId ?? 'crawler', `version.${status}`, row.id, { project: p.slug, version, origin: input.origin, verdict: report.verdict });
  const page = `${ctx.cfg.HUB_PORTAL_URL}projects/${p.slug}/versions`;
  if (status === 'held') await ctx.notify({ kind: 'hold', text: `Version ${version} of ${p.name} goes live at ${row.publish_at} (clean update, ${ctx.cfg.HOLD_MINUTES} min hold). Not you? Cancel in the portal.`, url: page });
  if (status === 'review') await ctx.notify({ kind: 'review', text: `Review needed: ${p.name} ${version} (${report.findings.filter((f) => f.severity === 'flag').map((f) => f.code).join(', ')})`, url: `${ctx.cfg.HUB_PORTAL_URL}admin` });
  return row;
}

async function publish(ctx: Ctx, v: VersionsTable, actor: string) {
  const at = nowIso();
  await ctx.db.updateTable('versions').set({ status: 'published', published_at: at, publish_at: null }).where('id', '=', v.id).execute();
  await ctx.db.updateTable('projects').set({ state: 'listed', updated_at: at }).where('id', '=', v.project_id).where('state', '!=', 'removed').execute();
  await ctx.audit(actor, 'version.publish', v.id);
  const p = await ctx.db.selectFrom('projects').select(['name', 'slug']).where('id', '=', v.project_id).executeTakeFirst();
  await ctx.notify({ kind: 'published', text: `Published: ${p?.name} ${v.version}`, url: `${ctx.cfg.HUB_PORTAL_URL}p/${p?.slug}` });
}

/** Publishes held versions whose hold is over (VirusTotal is asked again first). Returns how many. */
export async function publishDue(ctx: Ctx, now = nowIso()): Promise<number> {
  const due = await ctx.db.selectFrom('versions').selectAll().where('status', '=', 'held').where('publish_at', '<=', now).execute();
  let n = 0;
  for (const v of due) {
    const report = parseJson<CheckReport | null>(v.report, null);
    if (ctx.vt && report?.virusTotal && ['queued', 'unknown', 'error'].includes(report.virusTotal.status)) {
      const vt = await ctx.vt.lookup(v.file_sha256);
      report.virusTotal = vt;
      if (vt.status === 'malicious' || vt.status === 'suspicious') {
        report.findings.push({ severity: 'flag', code: `vt.${vt.status}`, message: `VirusTotal before publishing: ${vt.positives} engines` });
        report.verdict = 'flagged';
        await ctx.db.updateTable('versions').set({ status: 'review', publish_at: null, report: JSON.stringify(report) }).where('id', '=', v.id).execute();
        continue;
      }
      await ctx.db.updateTable('versions').set({ report: JSON.stringify(report) }).where('id', '=', v.id).execute();
    }
    await publish(ctx, v, 'hold');
    n++;
  }
  if (n) await rebuildIndex(ctx);
  return n;
}

export async function versionById(ctx: Ctx, id: string): Promise<VersionsTable> {
  const v = await ctx.db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!v) throw new HttpError(404, 'not_found', 'Version not found');
  return v;
}

export async function approveVersion(ctx: Ctx, v: VersionsTable, actor: string) {
  if (v.status !== 'review' && v.status !== 'held') throw new HttpError(409, 'bad_state', `Version is ${v.status}`);
  await publish(ctx, v, actor);
  await rebuildIndex(ctx);
}

export async function rejectVersion(ctx: Ctx, v: VersionsTable, s: Omit<StatementOfReasons, 'decidedAt' | 'decision' | 'decidedBy'>, actor: string) {
  if (!['review', 'held', 'checking'].includes(v.status)) throw new HttpError(409, 'bad_state', `Version is ${v.status}`);
  const d = statement({ ...s, decision: 'reject-version', decidedBy: actor });
  await ctx.db.updateTable('versions').set({ status: 'rejected', publish_at: null, decision: JSON.stringify(d) }).where('id', '=', v.id).execute();
  await ctx.audit(actor, 'version.reject', v.id, d);
}

export async function cancelVersion(ctx: Ctx, v: VersionsTable, actor: string) {
  if (v.status !== 'held' && v.status !== 'review') throw new HttpError(409, 'bad_state', 'Only versions on hold or in review can be cancelled');
  await ctx.db.updateTable('versions').set({ status: 'cancelled', publish_at: null }).where('id', '=', v.id).execute();
  await ctx.audit(actor, 'version.cancel', v.id);
}

export async function revokeVersion(ctx: Ctx, v: VersionsTable, s: Omit<StatementOfReasons, 'decidedAt' | 'decision' | 'decidedBy'>, actor: string) {
  if (v.status !== 'published') throw new HttpError(409, 'bad_state', 'Only published versions can be revoked');
  const d = statement({ ...s, decision: 'revoke-version', decidedBy: actor });
  const p = await ctx.db.selectFrom('projects').select(['slug', 'name']).where('id', '=', v.project_id).executeTakeFirstOrThrow();
  await ctx.db.updateTable('versions').set({ status: 'revoked', decision: JSON.stringify(d) }).where('id', '=', v.id).execute();
  await ctx.db.insertInto('revocations').values({ version_id: v.id, project_slug: p.slug, version: v.version, sha256: v.file_sha256, reason: s.facts.slice(0, 300), revoked_at: d.decidedAt }).execute();
  await ctx.audit(actor, 'version.revoke', v.id, d);
  await ctx.notify({ kind: 'revoked', text: `Revoked: ${p.name} ${v.version} (${s.facts.slice(0, 200)})` });
  await rebuildIndex(ctx);
}

export function toHubVersion(ctx: Ctx, v: VersionsTable, uploader: { id: string; name: string } | null, full: boolean): HubVersion {
  return {
    id: v.id, projectId: v.project_id, version: v.version, channel: v.channel as HubVersion['channel'], changelog: v.changelog, games: parseJson(v.games, []),
    installs: parseJson(v.installs, {}), status: v.status as VersionStatus, publishAt: v.publish_at, published: v.published_at,
    files: filesOf(ctx, v),
    report: full ? parseJson(v.report, null) : null, origin: full ? v.origin : v.origin.replace(/^upload$|^api-token$/, 'upload'), uploader: full ? uploader : null,
    authorSignature: parseJson(v.signature, null), verified: !!v.verified, decision: parseJson(v.decision, null), downloads: v.downloads, created: v.created_at,
  };
}
