// Skid marks Classic / Clean (Nations and United Forever). Rust side: skidmarks.rs.
// Game under Program Files + TMLoader: Clean installs the TMLoader product "Skid Marks" (no admin, nothing
// written into the game folder; unverified whether TMLoader lays its GameData over the game, the card says so).
// The direct switch of the game file stays as the fallback ("Game files"; in Program Files one UAC prompt copies
// the known file, elevate.rs). A game file that is already Clean/Custom is shown as it is (mode "gameFolder"):
// the TMLoader product would be redundant, Classic goes the direct way.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ShieldCheck, Undo2 } from 'lucide-react';
import { isNative } from '../data/backend';
import { useT } from '../i18n';
import { tmlName, useHubState } from '../state';
import type { GameView } from '../data/types';

interface TmlSkid { available: boolean; installed: boolean; profilesOn: string[]; profiles: string[] }
interface SkidState { mark: 'classic' | 'clean' | 'custom' | 'missing'; canClean: boolean; canRestore: boolean; protected?: boolean; tml?: TmlSkid; mode?: 'direct' | 'tml' | 'gameFolder' }

export function SkidMarks({ g }: { g: GameView }) {
  const t = useT();
  const hub = useHubState();
  const [st, setSt] = useState<SkidState | null>(null);
  const [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    if (isNative && g.installed && (g.id === 'tmnf' || g.id === 'tmuf')) invoke<SkidState | null>('skid_state', { game: g.id }).then(setSt).catch(() => setSt(null));
  }, [g.id, g.installed]);
  if (!st) return null;
  const run = async (cmd: string, args: Record<string, unknown>) => {
    setBusy(true);
    try { setSt(await invoke<SkidState>(cmd, { game: g.id, ...args })); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  // Program Files: the backend copies the known file with one UAC prompt.
  const set = (clean: boolean) => run('skid_set', { clean, admin: !!st.protected });
  const shield = st.protected ? <ShieldCheck size={14} /> : null;
  const tml = st.tml;

  // TMLoader is there, but the game file is already changed: say so, no redundant product.
  if (st.mode === 'gameFolder' && !direct) {
    return (
      <section className="panel">
        <div className="tool-card sg-row" style={{ alignItems: 'center', gap: 12 }}>
          <div className="grow">
            <b>{t('skid.title')}</b>
            <div className="dim small">{st.mark === 'clean' ? t('v052.skid.gameClean') : t('v052.skid.gameCustom')}</div>
            {tml?.installed && <div className="dim small">{t('v052.skid.tmlRedundant')} <button className="linkish small" disabled={busy} onClick={() => void run('skid_tml_remove', {})}>{t('v052.skid.removeTml')}</button></div>}
          </div>
          <div className="seg" role="group" aria-label={t('skid.title')}>
            <button className="btn sm ghost" disabled={busy || !st.canRestore} onClick={() => void set(false)} title={st.protected ? t('v052.skid.adminTip') : undefined}>{shield} {t('skid.classic')}</button>
            <button className={'btn sm ' + (st.mark === 'clean' ? 'primary' : 'ghost')} disabled={busy || st.mark === 'clean' || !st.canClean} onClick={() => void set(true)} title={st.mark === 'clean' ? t('v052.skid.gameClean') : st.protected ? t('v052.skid.adminTip') : undefined}>{st.mark !== 'clean' && shield} {t('skid.clean')}</button>
          </div>
        </div>
      </section>
    );
  }

  // TMLoader way: offered when the game sits in Program Files, TMLoader is there and the game file is Classic.
  if (st.mode === 'tml' && tml && !direct) {
    const want = tmlName(hub.profileFor(g.id));
    const profile = want && tml.profiles.includes(want) ? want : tml.profiles.includes('default') ? 'default' : tml.profiles[0];
    const on = tml.installed && !!profile && tml.profilesOn.includes(profile);
    return (
      <section className="panel">
        <div className="tool-card sg-row" style={{ alignItems: 'center', gap: 12 }}>
          <div className="grow">
            <b>{t('skid.title')}</b>
            <div className="dim small">{on ? t('skid.tmlOn', { profile: profile ?? '' }) : t('skid.tmlText')}</div>
            <div className="dim small">{t('skid.tmlTest')}</div>
          </div>
          <div className="seg" role="group" aria-label={t('skid.title')}>
            <button className={'btn sm ' + (!on ? 'primary' : 'ghost')} disabled={busy || !on} onClick={() => void run('skid_tml_remove', {})}>{t('skid.classic')}</button>
            <button className={'btn sm ' + (on ? 'primary' : 'ghost')} disabled={busy || on || !st.canClean || !profile} onClick={() => void run('skid_tml_install', { profiles: profile ? [profile] : [] })} title={t('skid.tmlTip')}>{t('skid.clean')}</button>
          </div>
          <button className="linkish small" onClick={() => setDirect(true)} title={t('skid.directTip')}>{t('skid.direct')}</button>
        </div>
      </section>
    );
  }

  const note = st.mark === 'missing' ? t('skid.missing') : st.mark === 'custom' ? t('skid.custom') : !st.canClean && st.mark === 'classic' ? t('skid.noSource') : t('skid.text');
  return (
    <section className="panel">
      <div className="tool-card sg-row" style={{ alignItems: 'center', gap: 12 }}>
        <div className="grow"><b>{t('skid.title')}</b><div className="dim small">{note}</div>{st.protected && <div className="dim small">{t('skid.admin')}</div>}</div>
        {st.mark === 'custom' && st.canRestore && <button className="btn ghost sm" disabled={busy} onClick={() => void set(false)}>{shield ?? <Undo2 size={14} />} {t('skid.restore')}</button>}
        {st.mark !== 'missing' && (
          <div className="seg" role="group" aria-label={t('skid.title')}>
            <button className={'btn sm ' + (st.mark === 'classic' ? 'primary' : 'ghost')} disabled={busy || st.mark === 'classic' || !st.canRestore} onClick={() => void set(false)}>{st.mark !== 'classic' && shield} {t('skid.classic')}</button>
            <button className={'btn sm ' + (st.mark === 'clean' ? 'primary' : 'ghost')} disabled={busy || st.mark === 'clean' || !st.canClean} onClick={() => void set(true)}>{st.mark !== 'clean' && shield} {t('skid.clean')}</button>
          </div>
        )}
        {direct && <button className="linkish small" onClick={() => setDirect(false)}>{t('skid.useTml')}</button>}
      </div>
    </section>
  );
}
