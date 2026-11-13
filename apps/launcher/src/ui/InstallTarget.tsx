// "Install into" for TMLoader mods: which Forever games it works with and which profiles it is
// switched on in. Files go into TMLoader's shared library once; ticking a profile switches it on there.
import { useMemo, useState } from 'react';
import { Download, Loader2, Plus } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import type { ModView } from '../data/model';
import { tmlName, useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { TmloaderSetupCard } from './TmloaderSetup';

export function InstallTargetDialog({ modId, onClose }: { modId: string; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const m = hub.mods.find((x) => x.id === modId) as ModView | undefined;
  const current = tmlName(hub.profileFor('tmuf'));
  const profiles = useMemo(() => hub.profiles.map(tmlName).filter((n): n is string => !!n), [hub.profiles]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(current ? [current] : []));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  const installed = m.installedVersions.length > 0;
  const enableable = m.type === 'modification' && m.id !== 'CoreMod';
  const games = (['tmnf', 'tmuf'] as const).filter((g) => m.games.includes(g) && hub.game(g).installed);
  const already = new Set(hub.profiles.filter((p) => p.mods.some((x) => x.id === m.id)).map(tmlName));
  const flip = (n: string) => setTicked((s) => { const c = new Set(s); if (c.has(n)) c.delete(n); else c.add(n); return c; });

  const run = async () => {
    setBusy(true);
    const t0 = performance.now();
    const targets = [...ticked].filter((n) => !already.has(n));
    const name = newName.trim();
    if (name) {
      const r = await backend.profileCreate!(name, []);
      if (!r.ok) { hub.toast(r); setBusy(false); return; }
      targets.push(name);
    }
    if (!installed) {
      const version = m.latest ?? m.installedLatest ?? '';
      hub.setBusy((b) => ({ ...b, ['mod:' + m.id]: 'download' }));
      const first = enableable ? targets.shift() : undefined;
      const r = await backend.installMod(m.id, version, first ?? '', !!first);
      hub.setBusy((b) => { const n = { ...b }; delete n['mod:' + m.id]; return n; });
      if (!r.ok) { hub.toast(r); setBusy(false); return; }
    }
    if (enableable) {
      for (const p of targets) {
        const r = await backend.setProfileMod!(p, m.id, true);
        if (!r.ok) { hub.toast(r); break; }
      }
    }
    backend.perfLog?.(installed ? 'add-mod' : 'install-mod', performance.now() - t0);
    const where = [...ticked, ...(name ? [name] : [])];
    hub.toast({ message: where.length && enableable ? t('target.doneIn', { mod: m.name, profiles: where.join(', ') }) : t('target.done', { mod: m.name }) });
    setBusy(false);
    onClose();
  };

  if (isNative && !hub.snapshot.tmloader.installed) {
    return (
      <Modal title={<><Download size={18} /> {t('target.title', { mod: m.name })}</>} onClose={onClose}
        actions={<button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>}>
        <TmloaderSetupCard modId={m.id} onReady={onClose} />
      </Modal>
    );
  }

  return (
    <Modal title={<><Download size={18} /> {t('target.title', { mod: m.name })}</>} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={run} disabled={busy || (installed && !newName.trim() && [...ticked].every((n) => already.has(n)))}>
          {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {installed ? t('target.add') : t('common.install')}
        </button>
      </>}>
      <div className="target">
        <div className="target-row">
          <span className="dim small">{t('target.games')}</span>
          <div className="target-chips">
            {games.length ? games.map((g) => <span key={g} className="pill tiny">{hub.game(g).name}</span>) : <span className="dim small">{t('target.noGame')}</span>}
          </div>
        </div>
        {enableable && (
          <div className="target-row">
            <span className="dim small">{t('target.profiles')}</span>
            <div className="target-list">
              {profiles.map((n) => (
                <label key={n} className="target-check">
                  <input type="checkbox" checked={ticked.has(n) || already.has(n)} disabled={already.has(n) || busy} onChange={() => flip(n)} />
                  <span>{n}</span>
                  {already.has(n) && <span className="dim small">{t('target.already')}</span>}
                  {n === current && !already.has(n) && <span className="dim small">{t('target.current')}</span>}
                </label>
              ))}
              <label className="target-check new">
                <Plus size={14} />
                <input className="input sm" value={newName} placeholder={t('target.newProfile')} onChange={(e) => setNewName(e.target.value)} disabled={busy} maxLength={40} />
              </label>
            </div>
          </div>
        )}
        <p className="dim small">{t('target.explain')}</p>
      </div>
    </Modal>
  );
}
