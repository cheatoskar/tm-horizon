import { useState } from 'react';
import { Check, Download } from 'lucide-react';
import { useHubState } from '../state';
import { GameChip, SampleBadge } from '../ui/common';
import { SAMPLE_PACKS, SAMPLE_SKINS } from '../data/sample';
import { isNative } from '../data/backend';
import { Embedded } from './Embedded';
import { useT } from '../i18n';

const SKINS_DIR = 'Documents\\TrackMania\\Skins';

export function SkinCards({ kind, compact }: { kind: 'skins' | 'packs'; compact?: boolean }) {
  const hub = useHubState();
  const t = useT();
  // Made-up cards for the browser preview only; public builds contain no sample data (vite.config.ts checks it).
  const src = __PUBLIC_BUILD__ ? [] : kind === 'skins' ? SAMPLE_SKINS : SAMPLE_PACKS;
  const [installed, setInstalled] = useState<Record<string, boolean>>(() => Object.fromEntries(src.map((s) => [s.id, s.installed])));
  return (
    <div className={'skin-grid' + (compact ? ' compact' : '')}>
      {src.map((s) => (
        <div className="skin" key={s.id}>
          <div className="skin-art"><img src={`art/${s.art}-card.jpg`} alt="" loading="lazy" /><span className="skin-kind">{s.kind}</span></div>
          <div className="skin-body">
            <div className="grow">
              <b>{s.name}</b>
              <div className="skin-meta"><GameChip id={s.game} /><span className="dim small nowrap">{t('skins.by', { author: s.author })} · {s.size}</span></div>
            </div>
            {installed[s.id]
              ? <span className="pill ok"><Check size={13} /> {t('common.installed')}</span>
              : <button className="btn primary sm" title={t('skins.installTip')}
                  onClick={() => { setInstalled({ ...installed, [s.id]: true }); hub.toast({ message: t('skins.previewInstall', { name: s.name, path: SKINS_DIR }) }); }}>
                  <Download size={14} /> {t('common.install')}
                </button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Native: ManiaPark (by the Mania Exchange team) embedded, downloads go into the game's
// skin folders. Preview: the sample cards below.
export function Skins({ initial }: { initial?: string }) {
  return isNative || __PUBLIC_BUILD__ ? <Embedded mode="skins" initial={initial} /> : <SampleSkins />;
}

function SampleSkins() {
  const t = useT();
  const [tab, setTab] = useState<'all' | 'skins' | 'packs'>('all');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('skins.title')}</h1>
          <span className="dim">{t('skins.sub')}</span>
        </div>
        <div className="grow" />
        <SampleBadge title={t('skins.sampleTip')} />
        <div className="seg">
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>{t('common.all')}</button>
          <button className={tab === 'skins' ? 'on' : ''} onClick={() => setTab('skins')}>{t('skins.carSkins')}</button>
          <button className={tab === 'packs' ? 'on' : ''} onClick={() => setTab('packs')}>{t('skins.packs')}</button>
        </div>
      </div>
      {tab !== 'packs' && <><h3 className="lib-sub first">{t('skins.carSkins')}</h3><SkinCards kind="skins" /></>}
      {tab !== 'skins' && <><h3 className="lib-sub">{t('skins.packsLong')}</h3><SkinCards kind="packs" /></>}
      <p className="dim small foot-note">{t('skins.foot', { path: SKINS_DIR })}</p>
    </div>
  );
}
