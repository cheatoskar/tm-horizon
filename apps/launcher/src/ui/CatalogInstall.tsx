// Install of a catalog mod (entry with an installSpec): pick the game, prepare (the backend downloads
// the file and lists what it would write), confirm with every file and warning, apply, and restore
// from a backup later. The Rust side (catalogmods.rs) only writes inside the chosen game's folders.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArchiveRestore, Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import type { CatalogEntry } from '@tm-hub/shared';
import { backend, type CatalogBackup, type CatalogPlan, type HhTarget, type InstallSpec } from '../data/backend';
import { tmlName, useHubState } from '../state';
import type { ModView } from '../data/model';
import { useT, fmtStamp } from '../i18n';
import { Modal } from './Modal';
import { TmloaderSetupCard } from './TmloaderSetup';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A required TMLoader product and what the install will do with it. */
type Dep = { name: string; mod: ModView | null; version: string | null; install: boolean; via?: string };

/** Requirements (TMUnlimiter, CoreMod, ...) resolved against the TMLoader index, with their own
 * dependencies from the index (one level is enough: TMLoader's install resolves the rest). */
function resolveDeps(names: string[], mods: ModView[]): Dep[] {
  const out: Dep[] = [];
  const add = (name: string, via?: string) => {
    const m = mods.find((x) => norm(x.id) === norm(name) || norm(x.name) === norm(name)) ?? null;
    if (out.some((d) => norm(d.mod?.id ?? d.name) === norm(m?.id ?? name))) return;
    const installed = !!m && m.installedVersions.length > 0;
    out.push({ name: m?.name ?? name, mod: m, version: m ? (installed ? m.installedLatest : m.latest) ?? null : null, install: !!m && !installed, via });
    const v = m?.remote?.versions.find((x) => x.version === m.latest) ?? m?.remote?.versions[0];
    for (const d of v?.dependencies ?? []) add(d.id, m?.name);
  };
  // TMLoader is the loader itself (checked by the installer), not a product in its index.
  names.filter((n) => norm(n) !== 'tmloader').forEach((n) => add(n));
  return out;
}

export function CatalogInstallDialog({ entry, spec, onClose }: { entry: Pick<CatalogEntry, 'id' | 'name'>; spec: InstallSpec; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const api = backend.catalogMods;
  const games = spec.games.filter((g) => hub.games.some((x) => x.id === g && x.installed));
  const [game, setGame] = useState(games.includes(hub.selectedGame) ? hub.selectedGame : games[0] ?? '');
  const [plan, setPlan] = useState<CatalogPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [failedApply, setFailedApply] = useState(false);

  // The author's own loader (dinput8.dll the hub allowed, e.g. Legacy Essentials) for ESWC, Sunrise, Original:
  // pick the copy (every install and instance). A copy with Horizon Client already has it; StarForce games are
  // never listed (the backend refuses them too).
  const loader = (spec.starForceBlocked?.length ?? 0) > 0 && ['tmn-eswc', 'tm-sunrise', 'tm-original'].includes(game);
  const [copies, setCopies] = useState<HhTarget[] | null>(null);
  const [copyDir, setCopyDir] = useState('');
  useEffect(() => {
    setCopies(null);
    if (!loader || !backend.horizon) return;
    let live = true;
    backend.horizon.targets(game).then((list) => {
      if (!live) return;
      setCopies(list);
      const sel = hub.game(game)?.install?.path?.toLowerCase();
      const free = list.filter((c) => !c.hostInstalled);
      setCopyDir((free.find((c) => c.dir.toLowerCase() === sel) ?? free[0])?.dir ?? '');
    }).catch(() => { if (live) setCopies([]); });
    return () => { live = false; };
  }, [loader, game]); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = copies?.find((c) => c.dir === copyDir) ?? null;
  const allInClient = loader && !!copies && copies.length > 0 && copies.every((c) => !!c.hostInstalled);

  const needs = [...new Set([...(spec.requires ?? []), ...(plan?.requires ?? [])])];
  const deps = useMemo(() => resolveDeps(needs, hub.mods), [needs.join('|'), hub.mods]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = deps.filter((d) => !d.mod);
  // Mods TMLoader loads per profile (CoreMod is a library: TMLoader loads it for the mods that need it).
  // TMInterface belongs in a TAS profile only (TMX rules): installed if missing, never ticked here.
  const tickable = deps.filter((d) => d.mod && d.mod.type === 'modification' && d.mod.id !== 'CoreMod' && norm(d.mod.id) !== 'tminterface');
  const profiles = useMemo(() => hub.profiles.map(tmlName).filter((n): n is string => !!n), [hub.profiles]);
  const current = tmlName(hub.profileFor(game === 'tmnf' || game === 'tmuf' ? game : 'tmuf'));
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(current ? [current] : []));
  const flip = (n: string) => setTicked((s) => { const c = new Set(s); if (c.has(n)) c.delete(n); else c.add(n); return c; });
  const onIn = (d: Dep, p: string) => hub.profiles.some((x) => tmlName(x) === p && x.mods.some((m) => m.id === d.mod!.id));

  /** Installs missing requirements from the TMLoader index and ticks them in the chosen profiles. */
  const resolve = async (): Promise<string | null> => {
    for (const d of deps.filter((x) => x.install && x.mod)) {
      const canTick = tickable.includes(d);
      const first = canTick ? [...ticked][0] : undefined;
      hub.setBusy((b) => ({ ...b, ['mod:' + d.mod!.id]: 'download' }));
      const r = await backend.installMod(d.mod!.id, d.version ?? '', first ?? '', !!first);
      hub.setBusy((b) => { const n = { ...b }; delete n['mod:' + d.mod!.id]; return n; });
      if (!r.ok) return `${d.name}: ${r.message}`;
    }
    for (const d of tickable) {
      for (const p of ticked) {
        if (onIn(d, p) || !backend.setProfileMod) continue;
        const r = await backend.setProfileMod(p, d.mod!.id, true);
        if (!r.ok && !/already/i.test(r.message)) return `${d.name}: ${r.message}`;
      }
    }
    return null;
  };

  // The chosen profile has a separate installation: file mods go into its folder ("<game>@<id>").
  const forever = (g: string) => g === 'tmnf' || g === 'tmuf';
  const profInst = hub.profileFor(game)?.instance;
  const inst = spec.kind === 'files' && profInst ? hub.instances.find((i) => i.id === profInst && (i.game === game || (forever(i.game) && forever(game)))) ?? null : null;
  const target = loader && copy ? (copy.instanceId ? `${game}@${copy.instanceId}` : game) : inst ? `${game}@${inst.id}` : game;
  const targetDir = loader && copy && !copy.instanceId ? copy.dir : null;

  const prepare = async () => {
    if (!api || !game) return;
    setBusy(true);
    setErr(null);
    setFailedApply(false);
    try { setPlan(await api.prepare(spec, entry.id, target, targetDir)); } catch (e) { setErr(String(e)); setPlan(null); }
    setBusy(false);
  };
  const apply = async () => {
    if (!api || !plan) return;
    setBusy(true);
    setErr(null);
    // Requirements first: when one fails, no files of the mod are written.
    const depErr = deps.length ? await resolve() : null;
    if (depErr) { setBusy(false); setErr(depErr); setFailedApply(true); return; }
    const r = await api.apply(entry.id, plan.game);
    setBusy(false);
    if (!r.ok) { setErr(r.message); setFailedApply(true); return; }
    if (deps.length) await backend.rescan().catch(() => undefined);
    const extra = deps.filter((d) => d.mod).map((d) => `${d.name} ${d.version ?? ''}`.trim());
    hub.toast(extra.length ? { ok: true, message: `${r.message} + ${extra.join(', ')}` } : r);
    onClose();
    if (spec.kind === 'tmloader-product') {
      // The product is now in TMLoader's folder: refresh, then offer the profile ticks.
      await backend.rescan().catch(() => undefined);
      const want = new Set([norm(entry.id), norm(entry.name), norm(entry.id.replace(/^mod-/, '')), ...(entry.name.match(/\(([^)]+)\)/) ? [norm(entry.name.match(/\(([^)]+)\)/)![1])] : [])]);
      const m = hub.mods.find((x) => want.has(norm(x.id)) || want.has(norm(x.name)));
      hub.setDialog({ kind: 'install', modId: m?.id ?? entry.name.match(/\(([^)]+)\)/)?.[1] ?? entry.name });
    }
  };

  return (
    <Modal title={<><Download size={18} /> {t('catinst.title', { mod: entry.name })}</>} onClose={onClose} wide
      actions={<>
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        {plan
          ? <button className="btn primary" onClick={apply} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {t('catinst.go')}</button>
          : <button className="btn primary" onClick={prepare} disabled={busy || !game || !api || (loader && !copy)}>{busy ? <Loader2 size={15} className="spin" /> : null} {t('catinst.check')}</button>}
      </>}>
      <div className="eswc-plan catinst">
        {!api && <p className="dim small">{t('op.onlyApp')}</p>}
        {api && !games.length && <p className="dim small">{t('catinst.noGame')}</p>}
        {api && games.length > 0 && !plan && (
          <div className="target-row">
            <span className="dim small">{t('catinst.game')}</span>
            <div className="target-chips">
              {games.map((g) => (
                <button key={g} className={'btn sm ' + (g === game ? 'primary' : 'ghost')} onClick={() => setGame(g)} disabled={busy}>{hub.game(g)?.name ?? g}</button>
              ))}
              {/* Games the mod supports but that are not on this PC: shown, greyed, with the reason. */}
              {spec.games.filter((g) => !games.includes(g)).map((g) => (
                <button key={g} className="btn sm ghost" disabled title={t('common.notInstalled')}>{hub.game(g)?.name ?? g} <span className="dim small">· {t('common.notInstalled')}</span></button>
              ))}
            </div>
          </div>
        )}
        {inst && !loader && <p className="dim small">{t('inst.into', { name: inst.name })}</p>}
        {loader && !plan && copies && copies.length > 0 && (
          <div className="target-row">
            <span className="dim small">{t('catinst.copy')}</span>
            <div className="target-chips">
              {copies.map((c) => (
                <button key={c.dir} className={'btn sm ' + (c.dir === copyDir ? 'primary' : 'ghost')} disabled={busy || !!c.hostInstalled}
                  title={c.hostInstalled ? t('catinst.inClientTip') : c.dir} onClick={() => setCopyDir(c.dir)}>
                  {c.label || c.dir.split(/[\\/]/).pop()}{c.hostInstalled && <span className="dim small"> · {t('catinst.inClient')}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {allInClient && <p className="dim small">{t('catinst.allInClient')}</p>}
        {(spec.kind === 'tmloader-product' || deps.some((d) => d.mod)) && <TmloaderSetupCard />}
        {spec.note && <p className="dim small">{spec.note}</p>}
        {busy && !plan && <p className="dim small"><Loader2 size={13} className="spin" /> {t('catinst.preparing')}</p>}
        {err && (
          <div className="catinst-err">
            <p className="small warn"><AlertTriangle size={13} /> <b>{failedApply ? t('catinst.failed') : t('catinst.prepFailed')}</b></p>
            <p className="small catinst-errtext">{err}</p>
            <div className="catinst-errbtns">
              <button className="btn ghost sm" onClick={prepare} disabled={busy}><RefreshCw size={14} /> {t('catinst.retry')}</button>
              {plan?.root && backend.reveal && <button className="btn ghost sm" onClick={() => { void backend.reveal?.(plan.root); }}><FolderOpen size={14} /> {t('catinst.openFolder')}</button>}
            </div>
          </div>
        )}
        {plan && (
          <>
            <p className="dim small">{t('catinst.files', { n: plan.files.length, root: plan.root, v: plan.version })}</p>
            <ul className="catinst-files">
              {plan.files.map((f) => <li key={f.path}><code>{f.path}</code> <span className={'pill tiny ' + (f.action === 'replace' ? 'warn-pill' : 'muted')}>{t('eswcmods.act.' + f.action)}</span></li>)}
            </ul>
            {plan.warnings.map((w) => <p key={w} className="small warn"><AlertTriangle size={13} /> {w}</p>)}
            {deps.filter((d) => d.mod).length > 0 && (
              <ul className="catinst-files catinst-deps">
                {deps.filter((d) => d.mod).map((d) => (
                  <li key={d.name}>
                    <b>+ {d.name} {d.version}</b> <span className="dim small">({d.via ? t('catinst.depOf', { mod: d.via }) : t('catinst.required')})</span>{' '}
                    <span className={'pill tiny ' + (d.install ? 'warn-pill' : 'muted')}>{d.install ? t('catinst.depInstall') : t('catinst.depHave')}</span>
                  </li>
                ))}
              </ul>
            )}
            {tickable.length > 0 && profiles.length > 0 && (
              <div className="target-row">
                <span className="dim small">{t('catinst.depProfiles', { mods: tickable.map((d) => d.name).join(', ') })}</span>
                <div className="target-chips">
                  {profiles.map((p) => (
                    <button key={p} className={'btn sm ' + (ticked.has(p) ? 'primary' : 'ghost')} onClick={() => flip(p)} disabled={busy}>{p}</button>
                  ))}
                </div>
              </div>
            )}
            {missing.length > 0 && <p className="small warn"><AlertTriangle size={13} /> {t('catinst.depMissing', { list: missing.map((d) => d.name).join(', ') })}</p>}
            <p className="dim small">{t('catinst.backupNote')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Backups made before catalog mods replaced files, with Restore. */
export function CatalogBackups() {
  const hub = useHubState();
  const t = useT();
  const api = backend.catalogMods;
  const [list, setList] = useState<CatalogBackup[]>([]);
  const [ask, setAsk] = useState<CatalogBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { api?.backups().then(setList).catch(() => setList([])); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!api || !list.length) return null;
  const run = async () => {
    if (!ask) return;
    const b = ask;
    setAsk(null);
    setBusy(true);
    hub.toast(await api.restore(b.id));
    setBusy(false);
    load();
  };
  return (
    <details className="catinst-backups">
      <summary className="dim small">{t('catinst.backups', { n: list.length })}</summary>
      {list.slice(0, 12).map((b) => (
        <div className="pd-mod" key={b.id}>
          <span className="grow small"><b>{fmtStamp(b.created)}</b> <span className="dim">{b.reason} · {b.files.length} {t('catinst.filesShort')}</span></span>
          <button className="btn ghost sm" disabled={busy} onClick={() => setAsk(b)}><ArchiveRestore size={14} /> {t('eswcmods.restore')}</button>
        </div>
      ))}
      {ask && (
        <Modal title={t('eswcmods.confirmRestore')} onClose={() => setAsk(null)}
          actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={run}>{t('eswcmods.go')}</button></>}>
          <ul className="catinst-files">{ask.files.map((f) => <li key={f}><code>{f}</code> <span className="pill tiny warn-pill">{t('eswcmods.act.replace')}</span></li>)}</ul>
        </Modal>
      )}
    </details>
  );
}
