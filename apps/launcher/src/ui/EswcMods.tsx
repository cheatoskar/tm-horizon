// ESWC proxy-DLL mods: install / update / remove with a confirmation that lists every file, a
// backup before anything is replaced, and one-click restore. The Rust side (eswcmods.rs) only
// writes the scanned ESWC folder, never the StarForce folder, and dinput8.dll only for ESWC Autosave.
import { useEffect, useState } from 'react';
import { AlertTriangle, ArchiveRestore, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { backend, isNative, type EswcBackup, type EswcPlan, type ProxyScan } from '../data/backend';
import { useHubState } from '../state';
import { useT, fmtStamp } from '../i18n';
import { Modal } from './Modal';
import { useReleases } from '../pages/ModDoc';
import { cmpVersion } from '../data/model';

const MODS = [
  { id: 'TM Vibrant Shaders', short: 'TV', file: 'd3d9.dll', repo: 'https://github.com/cheatoskar/TM-Vibrant-Shaders' },
  { id: 'ESWC Autosave', short: 'EA', file: 'dinput8.dll', repo: 'https://github.com/cheatoskar/eswc-autosave' },
];

/** Latest non-pre-release tag of the mod's GitHub releases (undefined while loading, null when unknown). */
function useLatest(repo: string): string | null | undefined {
  const list = useReleases(repo);
  if (list === undefined) return undefined;
  const r = list.find((x) => !x.prerelease) ?? list[0];
  return r ? r.tag.replace(/^v/i, '') : null;
}

function ModRow({ m, have, busy, onInstall, onRemove }: {
  m: (typeof MODS)[number]; have: ProxyScan['mods'][number] | undefined; busy: boolean; onInstall: () => void; onRemove: () => void;
}) {
  const t = useT();
  const latest = useLatest(m.repo);
  const cmp = have?.version && latest ? cmpVersion(have.version, latest) : null;
  // Installed newer than the release (my own test build) or equal: nothing to update.
  const state = !have ? 'missing' : cmp === null ? 'unknown' : cmp < 0 ? 'older' : cmp === 0 ? 'current' : 'newer';
  return (
    <div className="pd-mod">
      <span className="mod-icon ph" style={{ width: 32, height: 32, fontSize: 12 }}>{m.short}</span>
      <span className="grow"><b>{m.id}</b> <span className="dim small">{have ? `${have.version ?? t('eswcmods.unknownVer')} · ${have.file}` : m.file}</span>
        {state === 'older' && <span className="pill tiny warn-pill">{t('updates.available', { v: latest ?? '' })}</span>}
        {state === 'current' && <span className="pill tiny ok">{t('eswcmods.current')}</span>}
        {state === 'newer' && <span className="pill tiny" title={t('eswcmods.newerTip', { v: latest ?? '' })}>{t('eswcmods.newer')}</span>}
      </span>
      {busy ? <Loader2 size={16} className="spin" /> : (
        <>
          {(state === 'missing' || state === 'older' || state === 'unknown') && (
            <button className={'btn sm ' + (state === 'older' ? 'primary' : 'ghost')} onClick={onInstall} title={t('eswcmods.installTip')}>
              {have ? <RefreshCw size={14} /> : <Download size={14} />} {state === 'older' ? t('eswcmods.update') : have ? t('hh.reinstall') : t('common.install')}
            </button>
          )}
          {have && <button className="btn ghost sm" onClick={onRemove} title={t('eswcmods.removeTip')}><Trash2 size={14} /></button>}
        </>
      )}
    </div>
  );
}

type Ask = { kind: 'install'; plan: EswcPlan } | { kind: 'remove'; modId: string; files: string[] } | { kind: 'restore'; backup: EswcBackup };

/** `only`: show just this mod (its own mod page). */
export function EswcMods({ scan, reload, only }: { scan: ProxyScan | null; reload: () => void; only?: string }) {
  const hub = useHubState();
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [backups, setBackups] = useState<EswcBackup[]>([]);
  const loadBackups = () => { backend.eswcMods?.backups().then(setBackups).catch(() => setBackups([])); };
  useEffect(loadBackups, []);
  if (!isNative || !backend.eswcMods) return null;
  const api = backend.eswcMods;

  const prepare = async (modId: string) => {
    setBusy(modId);
    try { setAsk({ kind: 'install', plan: await api.prepare(modId) }); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(null);
  };
  const run = async () => {
    if (!ask) return;
    const a = ask;
    setAsk(null);
    setBusy(a.kind === 'install' ? a.plan.modId : a.kind === 'remove' ? a.modId : 'restore');
    const r = a.kind === 'install' ? await api.apply(a.plan.modId) : a.kind === 'remove' ? await api.remove(a.modId) : await api.restore(a.backup.id);
    hub.toast(r);
    setBusy(null);
    reload();
    loadBackups();
  };

  return (
    <div className="eswc-mods">
      {MODS.filter((m) => !only || m.id === only).map((m) => {
        const have = scan?.mods.find((x) => x.id === m.id);
        return (
          <ModRow key={m.id} m={m} have={have} busy={busy === m.id} onInstall={() => prepare(m.id)}
            onRemove={() => have && setAsk({ kind: 'remove', modId: m.id, files: [have.file, ...have.files.filter((f) => f !== have.file)] })} />
        );
      })}
      {backups.length > 0 && (
        <details className="eswc-backups">
          <summary className="dim small">{t('eswcmods.backups', { n: backups.length })}</summary>
          {backups.slice(0, 8).map((b) => (
            <div className="pd-mod" key={b.id}>
              <span className="grow small"><b>{fmtStamp(b.created)}</b> <span className="dim">{b.reason} · {b.files.join(', ')}</span></span>
              <button className="btn ghost sm" disabled={busy === 'restore'} onClick={() => setAsk({ kind: 'restore', backup: b })}><ArchiveRestore size={14} /> {t('eswcmods.restore')}</button>
            </div>
          ))}
        </details>
      )}
      {ask && (
        <Modal title={ask.kind === 'install' ? t('eswcmods.confirmInstall', { mod: ask.plan.modId, v: ask.plan.version }) : ask.kind === 'remove' ? t('eswcmods.confirmRemove', { mod: ask.modId }) : t('eswcmods.confirmRestore')}
          onClose={() => setAsk(null)}
          actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={run}>{t('eswcmods.go')}</button></>}>
          <div className="eswc-plan">
            <p className="dim small">{t('eswcmods.files')}</p>
            <ul>
              {ask.kind === 'install' && ask.plan.files.map((f) => <li key={f.name}><code>{f.name}</code> <span className={'pill tiny ' + (f.action === 'replace' ? 'warn-pill' : 'muted')}>{t('eswcmods.act.' + f.action)}</span></li>)}
              {ask.kind === 'remove' && ask.files.map((f) => <li key={f}><code>{f}</code> <span className="pill tiny warn-pill">{t('eswcmods.act.remove')}</span></li>)}
              {ask.kind === 'restore' && ask.backup.files.map((f) => <li key={f}><code>{f}</code> <span className="pill tiny warn-pill">{t('eswcmods.act.replace')}</span></li>)}
            </ul>
            {ask.kind === 'install' && ask.plan.conflicts.map((c) => <p key={c} className="small warn"><AlertTriangle size={13} /> {c}</p>)}
            {((ask.kind === 'install' && ask.plan.touchesDinput8) || (ask.kind === 'remove' && ask.modId === 'ESWC Autosave') || (ask.kind === 'restore' && ask.backup.files.includes('dinput8.dll'))) && <p className="small warn"><AlertTriangle size={13} /> {t('eswcmods.dinput8')}</p>}
            <p className="dim small">{t('eswcmods.backupNote')}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
