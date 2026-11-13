// Backup of the Forever player data (profiles, settings, local records, optionally own tracks and
// replays) into a zip, and restore with a preview first. Rust side: src-tauri/src/backup.rs.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import { isNative } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';

interface Summary { files: number; bytes: number }
interface Plan { created: string; tracks: boolean; lines: { path: string; action: 'new' | 'replace' | 'same'; size: number }[] }

const mb = (n: number) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : Math.max(0.1, n / (1 << 20)).toFixed(1) + ' MB');

export function BackupPanel() {
  const t = useT();
  const hub = useHubState();
  const [tracks, setTracks] = useState(false);
  const [sum, setSum] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<{ path: string; plan: Plan } | null>(null);
  useEffect(() => { if (isNative) invoke<Summary>('backup_plan', { tracks }).then(setSum).catch(() => setSum(null)); }, [tracks]);
  if (!isNative) return null;

  const create = async () => {
    setBusy(true);
    try {
      const r = await invoke<[string, Summary] | null>('backup_create', { tracks });
      if (r) hub.toast({ ok: true, message: t('backup.done', { n: r[1].files, size: mb(r[1].bytes), path: r[0] }) });
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  const pick = async () => {
    try {
      const path = await invoke<string | null>('backup_pick');
      if (path) setRestore({ path, plan: await invoke<Plan>('backup_restore_plan', { path }) });
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
  };
  const run = async () => {
    if (!restore) return;
    const path = restore.path;
    setRestore(null);
    setBusy(true);
    try {
      const r = await invoke<Summary>('backup_restore', { path });
      hub.toast({ ok: true, message: t('backup.restored', { n: r.files }) });
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  const count = (a: string) => restore?.plan.lines.filter((l) => l.action === a).length ?? 0;

  return (
    <section className="panel">
      <div className="setrow">
        <div className="grow">
          <b>{t('backup.title')}</b>
          <div className="dim small setnote">{t('backup.sub')}{sum ? ' · ' + t('backup.size', { n: sum.files, size: mb(sum.bytes) }) : ''}</div>
        </div>
      </div>
      <div className="setrow">
        <label className="check small grow"><input type="checkbox" checked={tracks} onChange={(e) => setTracks(e.target.checked)} /> {t('backup.tracks')}</label>
        <button className="btn ghost sm" disabled={busy} onClick={create}>{busy ? <Loader2 size={14} className="spin" /> : <Archive size={14} />} {t('backup.create')}</button>
        <button className="btn ghost sm" disabled={busy} onClick={pick}><ArchiveRestore size={14} /> {t('backup.restore')}</button>
      </div>
      {restore && (
        <Modal title={t('backup.restoreTitle')} onClose={() => setRestore(null)}
          actions={<><button className="btn ghost" onClick={() => setRestore(null)}>{t('common.cancel')}</button><button className="btn primary" disabled={count('new') + count('replace') === 0} onClick={run}>{t('backup.restoreGo')}</button></>}>
          <p>{t('backup.preview', { created: restore.plan.created, nNew: count('new'), nReplace: count('replace'), nSame: count('same') })}</p>
          <p className="dim small">{t('backup.undoNote')}</p>
        </Modal>
      )}
    </section>
  );
}
