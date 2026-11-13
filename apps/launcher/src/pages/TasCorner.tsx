// TAS mode start page: one card per TAS tool. TMInterface (Nations/United Forever, started through a
// TMLoader profile with TMInterface + CoreMod), ForeverTAS and TICK (Trackmania 2020), all three as
// listed on TMTAS Exchange's tool page. TMTAS Exchange is the map and replay source.
// TAS tools are for offline use only (TMX rules): TAS mode has no server joins at all.
import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Cpu, ExternalLink, FileCog, FileText, Film, FolderOpen, Globe, Loader2, MessageCircle, Play, Plus, Puzzle, Save, Timer } from 'lucide-react';
import { backend, isNative, type TasInfo } from '../data/backend';
import { go, useHubState } from '../state';
import { PlayButton, ProfileSelect } from '../ui/common';
import { useT } from '../i18n';

export const TAS_TEMPLATE = { name: 'TAS', mods: ['TMInterface', 'CoreMod'] };

/** Links from TMTAS Exchange's tool list (https://tmtas.exchange/tas-tools, read 2026-11-10). "Get"
 * opens a page in the browser; TM Horizon never downloads or runs an installer itself. TICK's download
 * link leads straight to the installer file, so its "Get" opens the tool list instead. */
const TOOLS = {
  tminterface: { get: 'https://tmtas.exchange/tas-tools/tminterface/download', discord: 'https://discord.gg/FDxsnjNfkT' },
  forevertas: { get: 'https://tmtas.exchange/tas-tools/forevertas/download', discord: 'https://discord.gg/9uN3x9tETR' },
  tick: { get: 'https://tmtas.exchange/tas-tools', discord: 'https://discord.gg/bhRWXTSV8M', version: '2.2.0' },
};

const FOLDERS = ['scripts', 'plugins', 'states', 'config', 'replays'] as const;
const ICONS = { scripts: FileText, plugins: Puzzle, states: Save, config: FileCog, replays: Film } as const;

function CardHead({ icon, title, sub, status }: { icon: ReactNode; title: string; sub: string; status?: ReactNode }) {
  return (
    <div className="tas-card-head">
      <span className="tas-ico">{icon}</span>
      <div className="tas-card-text">
        <h3>{title}</h3>
        <span className="dim small">{sub}</span>
        {status && <div className="tas-status">{status}</div>}
      </div>
    </div>
  );
}

let lastInfo: TasInfo | null = null;

export function TasHome() {
  const hub = useHubState();
  const t = useT();
  const [info, setInfoState] = useState<TasInfo | null>(lastInfo);
  const setInfo = (i: TasInfo | null) => { if (i) lastInfo = i; setInfoState(i ?? lastInfo); };
  useEffect(() => { backend.tas?.info().then(setInfo).catch(() => setInfo(null)); }, [hub.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  const checking = isNative && !info;
  const checkingPill = <span className="pill tiny muted checking"><Loader2 size={11} className="spin" /> {t('common.checking')}</span>;
  const g = hub.game('tmuf').installed ? hub.game('tmuf') : hub.game('tmnf');
  const tmiVersion = hub.snapshot.tmloader.products?.TMInterface?.versions.filter((v) => v.installed).map((v) => v.version).pop();
  const tmiInstalled = !!tmiVersion || !!info?.tminterface;
  const profile = hub.profileFor(g.id);
  const open = async (key: string) => { const r = await backend.tas!.open(key); if (!r.ok) hub.toast(r); };
  const create = async () => {
    const r = await backend.profileCreate!(TAS_TEMPLATE.name, TAS_TEMPLATE.mods);
    hub.toast(r);
    if (r.ok && r.command) hub.selectProfile('forever', 'tml:' + r.command);
  };
  const folder = (key: (typeof FOLDERS)[number]) => info?.folders.find((f) => f.key === key);
  const ft = info?.forevertas;
  const tick = info?.tick;

  return (
    <div className="page tas-page">
      <div className="page-head">
        <div>
          <h1>TAS</h1>
          <span className="dim">{t('tas.sub')}</span>
        </div>
      </div>

      <div className="tas-grid">
        <section className="panel tas-card tas-main">
          <CardHead icon={<Cpu size={20} />} title="TMInterface" sub={t('tas.tmiSub')}
            status={<span className={'pill tiny ' + (tmiInstalled ? 'ok-pill' : 'muted')}>{tmiInstalled ? (tmiVersion ? t('tas.version', { v: tmiVersion }) : t('tas.installed')) : t('tas.ftMissing')}</span>} />

          <div className="tas-play">
            {profile
              ? <><PlayButton game={g} /><ProfileSelect game={g} /></>
              : <>
                  <span className="dim small grow">{t('tas.profileNone')}</span>
                  {isNative && hub.snapshot.tmloader.installed && <button className="btn primary" onClick={create} title={t('tas.templateTip')}><Plus size={16} /> {t('tas.createProfile')}</button>}
                </>}
          </div>

          <div className="tas-actions">
            {!tmiInstalled && <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.tminterface.get)} title={TOOLS.tminterface.get}><ExternalLink size={15} /> {t('common.get')}</button>}
            <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.tminterface.discord)} title={TOOLS.tminterface.discord}><MessageCircle size={15} /> Discord</button>
          </div>

          <div className="tas-sec">
            <h4 className="sub-head">{t('tas.folders')}</h4>
            <div className="tas-folders">
              {FOLDERS.map((key) => {
                const f = folder(key);
                const I = ICONS[key] ?? FolderOpen;
                const ok = !!f?.exists && tmiInstalled;
                return (
                  <button key={key} className="btn ghost" disabled={!ok} onClick={() => open(key)}
                    title={!isNative ? t('tas.onlyApp') : f ? (f.exists ? f.path : t('tas.missing', { path: f.path })) : t('tas.ftMissing')}>
                    <I size={15} /> <span className="ellip">{t('tas.f.' + key)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tas-sec">
            <h4 className="sub-head">{t('tas.plugins', { n: info?.plugins.length ?? 0 })}</h4>
            {info && info.plugins.length > 0
              ? <ul className="tas-chips">{info.plugins.map((p) => <li key={p} className="mono" title={p}>{p}</li>)}</ul>
              : <p className="dim small">{isNative ? t('tas.noPlugins') : t('tas.onlyApp')}</p>}
          </div>
        </section>

        <div className="tas-side">
          <section className="panel tas-card">
            <CardHead icon={<Bot size={20} />} title="ForeverTAS" sub={t('tas.ftSub')}
              status={checking ? checkingPill : <span className={'pill tiny ' + (ft?.installed ? 'ok-pill' : 'muted')}>{ft?.installed ? t('tas.version', { v: ft.version ?? '?' }) : t('tas.ftMissing')}</span>} />
            <div className="tas-actions">
              {checking ? <span className="btn ghost skeleton-btn" aria-hidden /> : ft?.installed
                ? <button className="btn primary" onClick={async () => hub.toast(await backend.tas!.startForeverTas())}><Play size={15} /> {t('tas.start')}</button>
                : <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.forevertas.get)} title={TOOLS.forevertas.get}><ExternalLink size={15} /> {t('common.get')}</button>}
              <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.forevertas.discord)} title={TOOLS.forevertas.discord}><MessageCircle size={15} /> Discord</button>
            </div>
          </section>

          <section className="panel tas-card">
            <CardHead icon={<Timer size={20} />} title="TICK" sub={t('tas.tickSub')}
              status={checking ? checkingPill : <span className={'pill tiny ' + (tick?.installed ? 'ok-pill' : 'muted')}>{tick?.installed ? (tick.version ? t('tas.version', { v: tick.version }) : t('tas.installed')) : t('tas.tickOffer', { v: TOOLS.tick.version })}</span>} />
            <div className="tas-actions">
              {checking ? <span className="btn ghost skeleton-btn" aria-hidden /> : tick?.installed
                ? <button className="btn primary" onClick={async () => hub.toast(await backend.tas!.startTick())}><Play size={15} /> {t('tas.start')}</button>
                : <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.tick.get)} title={TOOLS.tick.get}><ExternalLink size={15} /> {t('common.get')}</button>}
              {isNative && !checking && !tick?.installed && <button className="btn ghost" onClick={async () => { const r = await backend.tas!.locateTick(); if (r.message !== 'Cancelled') hub.toast(r); if (r.ok) backend.tas!.info().then(setInfo); }} title={t('tas.locateTip')}><FolderOpen size={15} /> {t('tas.locate')}</button>}
              <button className="btn ghost" onClick={() => backend.openExternal(TOOLS.tick.discord)} title={TOOLS.tick.discord}><MessageCircle size={15} /> Discord</button>
            </div>
          </section>

          <section className="panel tas-card">
            <CardHead icon={<Globe size={20} />} title="TMTAS Exchange" sub={t('tas.exchangeSub')} />
            <div className="tas-actions">
              <button className="btn ghost" onClick={() => go('maps', `${g.id}@tmtas.exchange`)}><Globe size={15} /> {t('common.open')}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
