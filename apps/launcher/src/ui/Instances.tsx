// Separate installations per profile (src-tauri/src/instances.rs): the "New profile" dialog with the
// "Separate installation" box, and the folder panel of a profile that has one.
import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, FolderOpen, HardDrive, Loader2, Plus, Trash2 } from 'lucide-react';
import { backend, isNative, type Instance, type InstanceCheck, type InstanceUsage } from '../data/backend';
import { fmtSize } from '../data/model';
import { tmlName, useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';

/** Games (per profile group) a separate installation can be made of. */
export const instanceGames = (group: string): string[] =>
  group === 'forever' ? ['tmuf', 'tmnf'] : group === 'tmn-eswc' || group.startsWith('tm2-') ? [group] : [];

export function NewProfileDialog({ group, defaultName, onPlain, onCreated, onClose }: { group: string; defaultName: string; onPlain: (name: string) => void; onCreated: (profileId: string) => void; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const games = instanceGames(group).filter((g) => hub.game(g)?.installed);
  const possible = isNative && !!backend.instances && games.length > 0;
  const [name, setName] = useState(defaultName);
  // Only Forever has plain profiles (TMLoader); for the other games a new profile is always its own folder.
  const onlySeparate = isNative && group !== 'forever';
  const [separate, setSeparate] = useState(onlySeparate && possible);
  const [game, setGame] = useState(games[0] ?? '');
  const [check, setCheck] = useState<InstanceCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const why = (code: string | null) => t(code === 'other-drive' ? 'inst.why.drive' : code === 'no-links' ? 'inst.why.fs' : 'inst.why.other');
  const errText = (e: string) => (e.startsWith('needs-copy: ') ? why(e.slice(12)) : e);

  useEffect(() => {
    if (!separate || !game || !backend.instances) { setCheck(null); return; }
    let live = true;
    setCheck(null);
    setErr(null);
    backend.instances.check(game).then((c) => { if (live) setCheck(c); }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [separate, game]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    if (!separate) { onPlain(n); onClose(); return; }
    if (!backend.instances || !check) return;
    setBusy(true);
    setErr(null);
    try {
      // The size warning was on screen: a full copy is what the user agreed to.
      const r = await backend.instances.create(n, game, !check.canLink);
      await hub.reloadInstances();
      onCreated('inst:' + r.instance.id);
      hub.toast({ ok: true, message: [t('inst.created', { name: r.instance.name }), ...r.warnings].join(' ') });
      onClose();
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  };

  return (
    <Modal title={<><Plus size={18} /> {t('inst.title')}</>} onClose={() => { if (!busy) onClose(); }}
      actions={<>
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={create} disabled={busy || !name.trim() || (separate && !check) || (onlySeparate && !separate)}>
          {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} {separate && check && !check.canLink ? t('inst.copy') : t('inst.create')}
        </button>
      </>}>
      <div className="target">
        <label className="target-row">
          <span className="dim small">{t('inst.name')}</span>
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} disabled={busy} autoFocus />
        </label>
        <label className="target-check" title={possible ? t('inst.separateTip') : t('inst.notHere')}>
          <input type="checkbox" checked={separate} disabled={!possible || busy || onlySeparate} onChange={(e) => setSeparate(e.target.checked)} />
          <span><b>{t('inst.separate')}</b> <span className="dim small">{possible ? t('inst.separateTip') : t('inst.notHere')}</span></span>
        </label>
        {separate && games.length > 1 && (
          <div className="target-row">
            <span className="dim small">{t('inst.game')}</span>
            <div className="target-chips">
              {games.map((g) => <button key={g} className={'btn sm ' + (g === game ? 'primary' : 'ghost')} onClick={() => setGame(g)} disabled={busy}>{hub.game(g)?.name ?? g}</button>)}
            </div>
          </div>
        )}
        {separate && !check && !err && <p className="dim small"><Loader2 size={13} className="spin" /> {t('inst.checking')}</p>}
        {separate && check && check.canLink && <p className="dim small">{t('inst.needs', { size: fmtSize(check.needBytes) })}</p>}
        {separate && check && !check.canLink && <p className="small warn"><AlertTriangle size={13} /> {t('inst.copyWarn', { note: why(check.note), size: fmtSize(check.needBytes) })}</p>}
        {busy && <p className="dim small"><Loader2 size={13} className="spin" /> {t('inst.creating')}</p>}
        {err && <p className="small warn"><AlertTriangle size={13} /> {errText(err)}</p>}
      </div>
    </Modal>
  );
}

/** Forever instance: start without TMLoader, or with the mods of a TMLoader profile through the
 * instance's own TMLoader copy (instancetml.rs; not tested with a real start yet). */
function TmlProfilePick({ inst }: { inst: Instance }) {
  const hub = useHubState();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const names = hub.profiles.map(tmlName).filter((n): n is string => !!n);
  const api = backend.instances;
  if (!api?.setTmlProfile || !hub.snapshot.tmloader.installed) return <p className="dim small">{t('inst.noTml')}</p>;
  const pick = async (v: string) => {
    setBusy(true);
    try {
      await api.setTmlProfile!(inst.id, v || null);
      await hub.reloadInstances();
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  return (
    <div className="inst-tml">
      <label className="select">
        <span className="dim small">{t('inst.tmlProfile')}</span>
        <select value={inst.tmlProfile ?? ''} disabled={busy} onChange={(e) => void pick(e.target.value)}>
          <option value="">{t('inst.tmlNone')}</option>
          {[...new Set([...names, ...(inst.tmlProfile ? [inst.tmlProfile] : [])])].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <p className="dim small">{inst.tmlProfile ? t('inst.tmlOn') : t('inst.noTml')}</p>
    </div>
  );
}

/** Folder, real and shared size, Open folder / Duplicate / Delete of a profile's separate installation. */
export function InstancePanel({ inst, group, copyName, onSelect }: { inst: Instance; group: string; copyName: string; onSelect: (profileId: string | null) => void }) {
  const hub = useHubState();
  const t = useT();
  const api = backend.instances;
  const [usage, setUsage] = useState<InstanceUsage | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setUsage(null);
    api?.usage(inst.id).then((u) => { if (live) setUsage(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [inst.id, api]);
  if (!api) return null;

  const duplicate = async () => {
    setBusy(true);
    try {
      const r = await api.duplicate(inst.id, copyName, false);
      await hub.reloadInstances();
      onSelect('inst:' + r.instance.id);
      hub.toast({ ok: true, message: [t('inst.created', { name: r.instance.name }), ...r.warnings].join(' ') });
    } catch (e) {
      // Duplicate never copies the whole game silently: no links possible means no duplicate.
      hub.toast({ ok: false, message: String(e).startsWith('needs-copy: ') ? t('inst.why.drive') : String(e) });
    }
    setBusy(false);
  };
  const remove = () => hub.setConfirm({
    title: t('inst.deleteTitle', { name: inst.name }), ok: t('common.delete'), cancel: t('common.cancel'),
    text: t('inst.deleteText'),
    onOk: async () => {
      try {
        await api.remove(inst.id);
        onSelect(null);
        await hub.reloadInstances();
        hub.toast({ ok: true, message: t('inst.deleted', { name: inst.name }) });
      } catch (e) {
        hub.toast({ ok: false, message: String(e) });
      }
    },
  });

  return (
    <div className="inst-panel">
      <div className="pd-meta">
        <span><HardDrive size={13} /> {t('inst.own')} <b>{usage ? fmtSize(usage.realBytes) : '…'}</b></span>
        <span title={t('inst.sharedTip')}>{t('inst.shared')} <b>{usage ? fmtSize(usage.linkedBytes) : '…'}</b></span>
        {inst.userDir && <span>{t('inst.userDir')} <b className="mono">{inst.userDir}</b></span>}
      </div>
      <div className="cmdline">
        <code title={inst.path}>{inst.path}</code>
      </div>
      {inst.exists === false && <p className="small warn"><AlertTriangle size={13} /> {t('inst.missing')}</p>}
      {group === 'forever' && <TmlProfilePick inst={inst} />}
      <div className="inst-btns">
        <button className="btn ghost sm" onClick={() => { void backend.reveal?.(inst.path); }} disabled={inst.exists === false}><FolderOpen size={14} /> {t('inst.openFolder')}</button>
        <button className="btn ghost sm" onClick={duplicate} disabled={busy || inst.exists === false}>{busy ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} {t('profiles.duplicate')}</button>
        <button className="btn ghost sm danger" onClick={remove} disabled={busy}><Trash2 size={14} /> {t('common.delete')}</button>
      </div>
    </div>
  );
}
