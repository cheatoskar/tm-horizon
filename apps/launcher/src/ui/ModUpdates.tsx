// Mods TM Horizon installed outside TMLoader's index (catalog mods, ESWC DLL mods): versions,
// "Update available", Update all, per-mod auto-update and rollback. Updates refuse while a game runs.
import { useEffect, useState } from 'react';
import { ArrowUpCircle, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { backend, isNative, type HostUpdate, type InstallRecord, type UpdateInfo } from '../data/backend';
import { CATALOG } from '../data/hub';
import { getHubSource, hubPayload } from '../data/hubIndex';
import { go, useHubState } from '../state';
import { useT } from '../i18n';
import { SectionHead, Toggle } from './common';

const nameOf = (id: string) => CATALOG.find((c) => c.id === id)?.name ?? id;
/** Hub projects are compared with the verified hub index when the hub source is on. */
const useHub = () => getHubSource().enabled && hubPayload() !== null;
/** Hub updates install the hub's current spec (new file and checksum), not the recorded one. */
const specFor = (u: UpdateInfo) => (u.via === 'hub' ? CATALOG.find((c) => c.id === u.entryId)?.installSpec ?? null : null);

/** Checks once at start-up and runs the updates whose auto-update switch is on (not while a game runs). */
let autoRan = false;
export function useAutoUpdates() {
  const hub = useHubState();
  useEffect(() => {
    if (autoRan || !backend.modUpdates) return;
    autoRan = true;
    const api = backend.modUpdates;
    setTimeout(async () => {
      try {
        const due = (await api.check(useHub())).filter((u) => u.update && u.autoUpdate);
        for (const u of due) {
          const r = await api.update(u.entryId, u.game, specFor(u));
          hub.toast(r.ok ? { message: `${nameOf(u.entryId)} ${u.latest}: ${r.message}` } : r);
        }
      } catch { /* offline: try next start */ }
    }, 8000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** File-installed mods with update and undo. `game`: only this game's installs (game page), without the Horizon Host rows. */
export function ModUpdates({ game }: { game?: string } = {}) {
  const hub = useHubState();
  const t = useT();
  const [recs, setRecs] = useState<InstallRecord[] | null>(null);
  const [info, setInfo] = useState<UpdateInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [host, setHost] = useState<HostUpdate[]>([]);
  const load = () => { backend.modUpdates?.installs().then((l) => setRecs(game ? l.filter((r) => r.game.split('@')[0] === game) : l)).catch(() => setRecs([])); };
  const check = async () => {
    setChecking(true);
    try { setInfo(await backend.modUpdates!.check(useHub())); } catch { /* keep */ }
    if (!game) try { setHost((await backend.horizon?.updates?.()) ?? []); } catch { /* keep */ }
    setChecking(false);
  };
  useEffect(() => { load(); if (backend.modUpdates) check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!isNative || !backend.modUpdates || !recs || (recs.length === 0 && host.length === 0)) return null;
  const api = backend.modUpdates;
  const key = (r: { entryId: string; game: string }) => r.entryId + '|' + r.game;
  const upd = (r: InstallRecord) => info.find((i) => key(i) === key(r));
  const due = recs.filter((r) => upd(r)?.update);
  const run = async (r: { entryId: string; game: string }, what: 'update' | 'rollback') => {
    setBusy(key(r));
    const u = info.find((i) => key(i) === key(r));
    hub.toast(await (what === 'update' ? api.update(r.entryId, r.game, u ? specFor(u) : null) : api.rollback(r.entryId, r.game)));
    setBusy(null);
    load();
    check();
  };
  return (
    <section className="panel mod-updates">
      <SectionHead title={t('updates.title')} sub={t('updates.sub', { n: recs.length })} right={<>
        <button className="btn ghost sm" onClick={check} disabled={checking}>{checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {t('updates.check')}</button>
        {due.length > 0 && <button className="btn primary sm" disabled={!!busy} onClick={async () => { for (const r of due) await run(r, 'update'); }}><ArrowUpCircle size={14} /> {t('updates.all', { n: due.length })}</button>}
      </>} />
      <div className="pd-mods">
        {host.map((h) => (
          <div className="pd-mod" key={'hh|' + h.dir} title={h.dir}>
            <span className="grow"><b>Horizon Client</b> <span className="dim small">{h.installed} · {hub.game(h.game)?.short ?? h.game} · {h.source === 'github' ? 'GitHub' : t('updates.localBuild')}</span>
              {h.update && <span className="pill tiny warn-pill">{t('updates.available', { v: h.latest ?? '' })}</span>}
              {h.error && <span className="dim small" title={h.error}> · {t('updates.checkFailed')}</span>}
            </span>
            {h.update && <button className="btn primary sm" onClick={() => go('game', h.game)} title={t('updates.hostTip')}><ArrowUpCircle size={14} /> {t('updates.open')}</button>}
          </div>
        ))}
        {recs.map((r) => {
          const u = upd(r);
          return (
            <div className="pd-mod" key={key(r)} title={r.files.join(', ')}>
              <span className="grow"><b>{nameOf(r.entryId)}</b> <span className="dim small">{r.version} · {hub.game(r.game.split('@')[0])?.short ?? r.game}{r.game.includes('@') ? ` · ${hub.instances.find((i) => i.id === r.game.split('@')[1])?.name ?? r.game.split('@')[1]}` : ''}</span>
                {u?.update && <span className="pill tiny warn-pill">{t('updates.available', { v: u.latest ?? '' })}</span>}
                {u?.revoked && <span className="pill tiny danger-pill" title={u.revoked}>{t('updates.revoked')}</span>}
                {u?.error && <span className="dim small" title={u.error}> · {t('updates.checkFailed')}</span>}
              </span>
              <span className="dim small">{t('updates.auto')}</span>
              <Toggle on={r.autoUpdate} label={t('updates.auto')} onChange={async () => { await api.setAuto(r.entryId, r.game, !r.autoUpdate); load(); }} />
              {busy === key(r) ? <Loader2 size={16} className="spin" /> : <>
                {u?.update && <button className="btn primary sm" onClick={() => run(r, 'update')}><ArrowUpCircle size={14} /> {t('common.update')}</button>}
                {r.backupId && <button className="btn ghost sm" onClick={() => run(r, 'rollback')} title={t('updates.rollbackTip')}><Undo2 size={14} /></button>}
              </>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
