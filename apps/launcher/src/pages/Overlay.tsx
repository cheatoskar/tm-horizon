import { useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useHubState } from '../state';
import { foreverMods } from './GamePage';
import { ModIcon, SampleBadge, Toggle } from '../ui/common';
import { SkinCards } from './Skins';
import { useT } from '../i18n';

// Mock of an in-game overlay (F8) drawn over a game screenshot.
export function Overlay({ tab: initial }: { tab?: string }) {
  const hub = useHubState();
  const t = useT();
  const [tab, setTab] = useState(initial === 'skins' || initial === 'packs' ? initial : 'mods');
  const profile = hub.profileFor('tmuf');
  const mods = foreverMods(hub.mods);
  const [changed, setChanged] = useState(false);
  return (
    <div className="ingame">
      <img className="ingame-bg" src="art/overlay-bg.jpg" alt="" />
      <div className="ingame-dim" />
      <div className="ov">
        <div className="ov-head">
          <div className="brand"><span className="brand-mark" />TM <b>HUB</b></div>
          <div className="ov-tabs">
            {(['mods', 'skins', 'packs'] as const).map((k) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t('overlay.tab.' + k)}</button>
            ))}
          </div>
          <div className="grow" />
          <span className="dim small">United Forever · {profile?.name}</span>
          <span className="kbd"><Keyboard size={13} /> F8</span>
          <button className="btn icon glass" aria-label={t('common.close')}><X size={16} /></button>
        </div>
        {tab === 'mods' && profile && (
          <>
            <div className="ov-tiles">
              {mods.map((m) => {
                const on = m.id === 'CoreMod' || profile.mods.some((x) => x.id === m.id);
                return (
                  <div key={m.id} className={'ov-tile' + (on ? ' on' : '')}>
                    <ModIcon mod={m} size={48} />
                    <b>{m.name}</b>
                    <span className="dim small">{m.installedLatest}</span>
                    {m.id === 'CoreMod'
                      ? <span className="dim small">{t('common.auto')}</span>
                      : <Toggle on={hub.modPending(profile.id, m.id) ?? on} busy={hub.modPending(profile.id, m.id) !== undefined} label={m.name} onChange={() => { hub.toggleMod(profile.id, m.id); setChanged(true); }} />}
                  </div>
                );
              })}
            </div>
            <div className="ov-foot">
              <span className={changed ? 'acc-text small' : 'dim small'}>{changed ? t('overlay.changed') : t('overlay.hint')}</span>
              <div className="grow" />
              {changed && <button className="btn primary sm">{t('overlay.restart')}</button>}
            </div>
          </>
        )}
        {tab !== 'mods' && (
          <>
            <div className="ov-sample"><SampleBadge /></div>
            <SkinCards kind={tab === 'skins' ? 'skins' : 'packs'} key={tab} compact />
          </>
        )}
      </div>
    </div>
  );
}
