import { AlertTriangle, ArrowLeft, ArrowUpCircle, BookOpen, Bug, Download, ExternalLink, Film, FolderOpen, Globe, Lock, Map as MapIcon, Play, RefreshCw, Save } from 'lucide-react';
import { useT } from '../i18n';
import { TMX_SITE } from '../data/tmx';
import { useEffect, useState } from 'react';
import { go, tmlName, useHubState } from '../state';
import { backend, isNative, type ProxyScan } from '../data/backend';
import { GameArt, GameLogo, ModIcon, PlayButton, ProfileSelect, SectionHead, TmText, Toggle } from '../ui/common';
import { cmpVersion, profileGameKey, timeAgo, type ModView } from '../data/model';
import { instanceGames } from '../ui/Instances';
import { OpInstalledPlugins } from './ModSources';
import { EswcMods } from '../ui/EswcMods';
import { SkidMarks } from '../ui/SkidMarks';
import type { GameView, Profile } from '../data/types';
import { EnvBackdrop, envOf } from '../ui/HeaderArt';
import { TmloaderSetupCard } from '../ui/TmloaderSetup';
import { LinuxGameSetupCard } from '../ui/LinuxGameSetup';
import { OpenplanetCard } from '../ui/OpenplanetSetup';
import { CompanionButtons } from '../ui/Related';
import { companionOf, relatedLinksOf, TM_WIKI } from '../data/links';
import { HorizonForeverCard, HorizonLegacyCard } from '../ui/HorizonHost';
import { horizonPluginName } from '@tm-hub/shared';
import { LiveServers } from '../ui/LiveServers';
import { qGameOf } from '../data/serverQuery';
import { HealthCheckCard } from '../ui/HealthCheck';
import { HistoryCard } from '../ui/History';
import { PerfPanel } from '../ui/PerfPanel';
import { gameSeconds, usePlaytime, useFormatTime } from '../ui/Playtime';
import { CommandLine, GameModsSection, InstallationsCard } from '../ui/GameMods';
import { ModUpdates } from '../ui/ModUpdates';
import { ClassicCard, ConsoleCard, HighlandsSwitch, isSteamPath, SteamFixCard, SuggestionsCard, UnitedHint, WhereToGet } from '../ui/Classics';

export function foreverMods(mods: ModView[]) {
  return mods.filter((m) => m.type === 'modification' && m.installedVersions.length > 0);
}

export function ModTile({ m, profile }: { m: ModView; profile: Profile }) {
  const hub = useHubState();
  const t = useT();
  const entry = profile.mods.find((x) => x.id === m.id);
  const on = !!entry;
  const isCore = m.id === 'CoreMod';
  const usedVersion = entry?.version ?? m.installedLatest;
  const update = m.latest && usedVersion && cmpVersion(m.latest, usedVersion) > 0;
  return (
    <div className={'tile' + (on || isCore ? ' on' : '')} onClick={() => go('mods', m.id)} role="button" tabIndex={0} title={m.description ?? m.name}>
      {update && <span className="tile-badge" title={t('game.updateTip', { v: m.latest })}><ArrowUpCircle size={13} /> {m.latest}</span>}
      <ModIcon mod={m} size={52} />
      <b className="tile-name" title={m.name}>{m.name}</b>
      <span className="tile-ver">{entry?.version ? t('common.fixedVer', { v: entry.version }) : usedVersion ?? ''}</span>
      <div className="tile-foot">
        {isCore
          ? <span className="dim small lockline" title={t('game.autoTip')}><Lock size={12} /> {t('common.auto')}</span>
          : <Toggle on={hub.modPending(profile.id, m.id) ?? on} busy={hub.modPending(profile.id, m.id) !== undefined} label={m.name} onChange={() => hub.toggleMod(profile.id, m.id)} />}
      </div>
    </div>
  );
}

const RECENT_FOLDER: Record<string, string> = {
  forever: 'Documents\\TrackMania\\Tracks', maniaplanet: 'Documents\\ManiaPlanet', tm2020: 'Documents\\Trackmania',
};

function Recent({ g }: { g: GameView }) {
  const hub = useHubState();
  const t = useT();
  const key = g.family === 'forever' ? 'forever' : g.family === 'maniaplanet' ? 'maniaplanet' : g.family === 'tm2020' ? 'tm2020' : null;
  if (!key) return null;
  const r = hub.snapshot.recent[key];
  const clean = (n: string) => n.replace(/\.(Replay|Challenge|Map)\.gbx$/i, '');
  const rows = [
    ...r.replays.slice(0, 4).map((x) => ({ ...x, kind: 'replay' as const })),
    ...r.maps.slice(0, 3).map((x) => ({ ...x, kind: 'map' as const })),
  ];
  return (
    <section className="panel">
      {/* Source: the newest .Gbx files in the game's Documents folder (scan.rs recent_files), read-only. */}
      <SectionHead title={<span title={t('game.recentTip', { folder: RECENT_FOLDER[key] })}>{t('game.recent')}</span>} sub={g.family === 'forever' ? t('game.recentSub') : undefined} />
      {rows.length === 0 && <div className="dim small">{t('game.noRecent')}</div>}
      <ul className="recent">
        {rows.map((x) => (
          <li key={x.kind + x.name}>
            {x.kind === 'replay' ? <Film size={15} /> : <MapIcon size={15} />}
            <TmText text={clean(x.name)} className="grow ellip" title={clean(x.name)} />
            <span className="dim small nowrap">{timeAgo(x.modified)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InstallInfoPanel({ g, profile }: { g: GameView; profile: Profile | null }) {
  const hub = useHubState();
  const t = useT();
  const [nativeCmd, setNativeCmd] = useState<string | null>(null);
  useEffect(() => {
    // The exact command Play runs (native: built by the Rust side).
    backend.launchPreview?.(g.id, g.family === 'forever' ? tmlName(profile) : null, profile?.instance ?? null).then(setNativeCmd).catch(() => setNativeCmd(null));
  }, [g.id, profile, hub.snapshot]);
  const cmd = nativeCmd ?? hub.commandFor(g, profile);
  const tmlProgram = hub.snapshot.tmloader.products?.TmForever;
  const played = usePlaytime();
  const fmt = useFormatTime();
  const secs = gameSeconds(played, g.id);
  const parts = Object.entries(played).filter(([k]) => k.startsWith(g.id + '@')).map(([k, e]) => `${hub.instances.find((i) => i.id === k.split('@')[1])?.name ?? k.split('@')[1]}: ${fmt(e.seconds)}`);
  return (
    <section className="panel">
      <SectionHead title={t('gm.start')} />
      <dl className="kv">
        <dt>{t('playtime.played')}</dt><dd title={parts.join('\n')}>{secs > 0 ? fmt(secs) : '-'}</dd>
        {g.family === 'forever' && tmlProgram && <>
          <dt>TMLoader</dt><dd className="ellip" title={tmlProgram.install ?? ''}>{t('game.loaderLine', { v: profile?.programVersion ?? tmlProgram.versions.filter((v) => v.installed).map((v) => v.version).sort(cmpVersion).pop(), folder: tmlProgram.install?.split('/').pop() })}</dd>
        </>}
        <dt>{t('game.startsWith')}</dt>
        <dd>{cmd ? <CommandLine text={cmd} max={40} /> : '-'}</dd>
      </dl>
      <div className="btn-grid2">
        {g.install && <button className="btn ghost sm" onClick={async () => (isNative ? backend.reveal!(g.install!.path).then((r) => { if (!r.ok) hub.toast(r); }) : hub.toast({ message: t('common.previewFolder'), command: g.install!.path }))}><FolderOpen size={15} /> {t('common.openFolder')}</button>}
        {TMX_SITE[g.id] && <button className="btn ghost sm" onClick={() => go('maps', g.id)} title={t('game.mapsTip', { host: TMX_SITE[g.id] })}><Globe size={15} /> {t('nav.maps')}</button>}
        <button className="btn ghost sm" title={TM_WIKI} onClick={() => backend.openExternal(TM_WIKI)}><BookOpen size={15} /> TrackMania Wiki</button>
        {isNative && backend.openGameFolder && g.family !== 'console' && <button className="btn ghost sm" onClick={() => backend.openGameFolder!(g.id, 'replays').then((r) => { if (!r.ok) hub.toast(r); })} title={t('game.replaysTip')}><Film size={15} /> {t('game.replaysFolder')}</button>}
        {isNative && backend.openGameFolder && g.family !== 'console' && <button className="btn ghost sm" onClick={() => backend.openGameFolder!(g.id, 'maps').then((r) => { if (!r.ok) hub.toast(r); })} title={t('game.mapsFolderTip')}><FolderOpen size={15} /> {t('game.mapsFolder')}</button>}
      </div>
    </section>
  );
}

/** TMX needs Competition Patch 2.0 for replay uploads to Nadeo/Classic tracks from 2026-11-19
 * (TMX news, 2026-11-04). Shown when the profile uses an older version. */
export const CP_ID = 'Competition Patch';
const CP_MIN = '2.0.0';

function CpNotice({ profile }: { profile: Profile }) {
  const hub = useHubState();
  const t = useT();
  const entry = profile.mods.find((m) => m.id === CP_ID);
  const cp = hub.mods.find((m) => m.id === CP_ID);
  const used = entry?.version ?? cp?.installedLatest ?? null;
  if (!entry || !used || cmpVersion(used, CP_MIN) >= 0) return null;
  const latest = cp?.latest && cmpVersion(cp.latest, CP_MIN) >= 0 ? cp.latest : null;
  const busy = !!hub.busy['mod:' + CP_ID];
  const update = async () => {
    if (!latest || !tmlName(profile)) return;
    hub.setBusy((b) => ({ ...b, ['mod:' + CP_ID]: 'download' }));
    let r = cp?.installedVersions.includes(latest) ? { ok: true, message: '' } : await backend.installMod(CP_ID, latest, profile.name, false);
    if (r.ok && entry.version) r = await backend.setProfileModVersion!(profile.name, CP_ID, latest);
    hub.setBusy((b) => { const n = { ...b }; delete n['mod:' + CP_ID]; return n; });
    hub.toast(r.ok ? { message: t('cp.updated', { v: latest, profile: profile.name }) } : r);
  };
  return (
    <div className="notice slim cp-notice">
      <AlertTriangle size={16} />
      <div className="small grow">{t('cp.notice', { v: used })}</div>
      {isNative && latest && tmlName(profile) && <button className="btn primary sm" disabled={busy} onClick={update}><ArrowUpCircle size={14} /> {t('common.update')}</button>}
    </div>
  );
}

const ESWC_AUTOSAVE = 'https://github.com/cheatoskar/eswc-autosave/releases/latest';

/** Proxy-DLL mods (d3d9.dll, dinput8.dll ...) found next to the game's exe, read-only. */
function useProxyMods(g: GameView): [ProxyScan | null, () => void] {
  const [scan, setScan] = useState<ProxyScan | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { if (g.installed && backend.proxyMods) backend.proxyMods(g.id).then(setScan).catch(() => setScan(null)); }, [g.id, g.installed, n]);
  return [scan, () => setN((x) => x + 1)];
}

function ProxyModList({ g }: { g: GameView }) {
  const t = useT();
  const [scan, reload] = useProxyMods(g);
  if (!isNative) return <p className="dim">{t('proxy.note')}</p>;
  if (!scan) return <p className="dim small">{t('common.checking')}</p>;
  return (
    <>
      <p className="dim small">{t('proxy.note')}</p>
      {g.family === 'eswc' && g.installed && <EswcMods scan={scan} reload={reload} />}
      <div className="pd-mods">
        {g.family !== 'eswc' && scan.mods.map((m) => (
          <div className="pd-mod" key={m.id} title={[m.file, ...m.files].join(', ')}>
            <span className="mod-icon ph" style={{ width: 32, height: 32, fontSize: 12 }}>{m.id.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>
            <span className="grow"><b>{m.id}</b> <span className="dim small">{m.version ?? ''} · {m.file}</span></span>
            <span className="pill tiny ok-pill">{t('common.installed')}</span>
          </div>
        ))}
        {scan.unknown.map((f) => (
          <div className="pd-mod" key={f}>
            <AlertTriangle size={16} />
            <span className="grow"><b>{f}</b> <span className="dim small">{t('proxy.unknown')}</span></span>
          </div>
        ))}
        {!scan.mods.length && !scan.unknown.length && <p className="dim small">{t('proxy.none')}</p>}
      </div>
    </>
  );
}

function EswcPanel({ g }: { g: GameView }) {
  const t = useT();
  const [on, setOn] = useState(() => !!backend.info?.().settings.eswcUseLauncher);
  const [scan] = useProxyMods(g);
  const autosave = scan?.mods.find((m) => m.id === 'ESWC Autosave');
  // Autosave as a module of the Horizon Client in this folder: then the stand-alone mod is not offered.
  const [inHost, setInHost] = useState(false);
  useEffect(() => {
    let live = true;
    const h = backend.horizon;
    if (!isNative || !h || !g.installed) return;
    h.targets(g.id).then((ts) => (ts[0]?.dir ? h.status(g.id, ts[0].dir) : null))
      .then((st) => { if (live) setInHost(!!st?.installed && st.plugins.some((p) => !!p.installed && (p.id === 'eswc-autosave' || p.id === 'autosave'))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [g.id, g.installed]);
  return (
    <section className="panel">
      <SectionHead title={t('eswc.title')} />
      {!g.installed && <p className="dim small">{t('eswc.getNote')}</p>}
      <div className="tool-card clickable" role="button" tabIndex={0} title={t('eswc.autosavePage')} onClick={() => go('mods', 'mod-eswc-autosave')} onKeyDown={(e) => { if (e.key === 'Enter') go('mods', 'mod-eswc-autosave'); }}>
        <Save size={20} />
        <div className="grow"><b>{inHost && !autosave ? horizonPluginName('eswc-autosave', 'ESWC Autosave') : 'ESWC Autosave'}</b><div className="dim small">{autosave ? (autosave.version ? t('proxy.autosaveOn', { v: autosave.version }) : t('proxy.autosaveOnNoVer')) : t('eswc.autosave')}</div></div>
        {inHost && !autosave
          ? <span className="pill tiny ok-pill" title={t('eswc.inHorizonTip')}>{t('eswc.inHorizon')}</span>
          : autosave
          ? <span className="pill tiny ok-pill">{t('common.installed')}</span>
          : isNative && g.installed
            ? <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); go('mods', 'mod-eswc-autosave'); }}><Download size={14} /> {t('common.install')}</button>
            : <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); backend.openExternal(ESWC_AUTOSAVE); }}><ExternalLink size={14} /> {t('common.get')}</button>}
      </div>
      {isNative && (
        <div className="start-options">
          <SectionHead title={t('eswc.startOptions')} />
          <div className="setrow" title={t('eswc.showSettingsTip')}>
            <div className="grow"><b>{t('eswc.showSettings')}</b><div className="dim small">{t('eswc.showSettingsTip')}</div></div>
            <Toggle on={on} label={t('eswc.showSettings')} onChange={async () => { await backend.saveSettings!({ eswcUseLauncher: !on }); setOn(!on); }} />
          </div>
        </div>
      )}
    </section>
  );
}

/** "Open <label>" buttons for the installed mods that have a companion page (TMLoader profile mods, proxy-DLL mods),
 * shown at the end of the Mods section. */
function GameCompanions({ g, profile }: { g: GameView; profile: Profile | null }) {
  const [scan] = useProxyMods(g);
  const hub = useHubState();
  if (!g.installed || g.modSystem === 'Openplanet') return null;
  const names: { id: string; name: string }[] = [
    ...(g.modSystem === 'TMLoader' && profile ? hub.mods.filter((m) => profile.mods.some((x) => x.id === m.id)).map((m) => ({ id: m.id, name: m.name })) : []),
    ...(scan?.mods ?? []).map((m) => ({ id: m.id, name: m.id })),
  ];
  const items = names.flatMap((n) => { const l = companionOf(relatedLinksOf(n.id, n.name)); return l ? [{ mod: n.name, link: l }] : []; });
  return <CompanionButtons items={items} game={g.id} />;
}

export function GamePage({ id }: { id: string }) {
  const hub = useHubState();
  const t = useT();
  const g = hub.game(id) ?? hub.game('tmuf');
  const profile = hub.profileFor(g.id);
  const fmods = foreverMods(hub.mods);
  const [proxy] = useProxyMods(g);
  // The start files are read once in the background, so the scanner checks them before the click.
  useEffect(() => { if (g.installed) backend.prewarmLaunch?.(g.id); }, [g.id, g.installed]);
  const opInstalled = g.family === 'tm2020' ? hub.snapshot.openplanet.tm2020.installed : g.family === 'maniaplanet' ? hub.snapshot.openplanet.maniaplanet.installed : false;
  return (
    <div className="gamepage">
      <section className={'hero small' + (envOf(g.id) ? ' has-env' : '')}>
        <EnvBackdrop game={g.id} />
        <GameArt game={g} variant="hero" className="hero-art" />
        <div className="hero-shade" />
        <button className="back" onClick={() => history.length > 1 ? history.back() : go('library')}><ArrowLeft size={16} /> {t('nav.library')}</button>
        <div className="hero-content">
          <div className="hero-kicker">{t('family.' + g.family)} · {g.year}{g.titleId && <> · {g.titleId}</>}</div>
          <GameLogo game={g} />
          <div className="hero-actions">
            <PlayButton game={g} />
            {g.installed && <ProfileSelect game={g} />}
            {g.installed && isNative && <button className="btn glass" title={t('report.tip')} onClick={() => hub.setDialog({ kind: 'report', gameId: g.id })}><Bug size={18} /> {t('report.button')}</button>}
          </div>
          {/* What a profile is and what "Separate installation" adds (games that can have one). */}
          {g.installed && instanceGames(profileGameKey(g.id)).length > 0 && <p className="hero-hint">{t('profiles.hint')}</p>}
        </div>
      </section>

      <div className="game-grid">
        <div className="col">
          {g.installed && <SuggestionsCard g={g} />}
          {g.family === 'console' && <ConsoleCard g={g} />}
          {g.family === 'classic' && <ClassicCard g={g} />}
          {g.family === 'forever' && g.installed && <TmloaderSetupCard game={g.id} />}
          {g.family === 'forever' && profile && tmlName(profile) && <CpNotice profile={profile} />}
          {/* Horizon Client first: the main block of the game page (status, install, its modules). */}
          <div id="horizon-client">
            {(g.family === 'eswc' || g.family === 'legacy') && g.installed && <HorizonLegacyCard g={g} />}
            {g.family === 'forever' && g.installed && <HorizonForeverCard g={g} profile={profile} />}
          </div>
          {g.family === 'forever' && g.installed && isSteamPath(g.install?.path) && <SteamFixCard g={g} />}
          {g.modSystem === 'Openplanet' && g.installed && <OpenplanetCard game={g.id} />}

          {/* Mods: the same section on every game page (installed for this game + available for it). */}
          {g.modSystem === 'TMLoader' && (
            <GameModsSection g={g} title={profile ? t('game.modsIn', { name: profile.name }) : undefined} sub={profile ? t('game.modsOn', { n: profile.mods.length }) : undefined}
              installed={profile
                ? <div className="tiles">{fmods.map((m) => <ModTile key={m.id} m={m} profile={profile} />)}{fmods.length === 0 && <p className="dim small">{t('gm.noneInstalled')}</p>}</div>
                : <p className="dim small">{t('gm.noProfile')}</p>}
              footer={<GameCompanions g={g} profile={profile} />} />
          )}
          {g.modSystem === 'Openplanet' && (
            <GameModsSection g={g} sub={opInstalled ? t('game.opFound') : t('game.opMissing')} installedNames={opInstalled ? ['Openplanet'] : []}
              installed={<><OpInstalledPlugins game={g.id} /><p className="dim small">{t('op.loadsAll')}</p></>} />
          )}
          {g.modSystem === 'None' && g.family !== 'classic' && g.family !== 'console' && (
            <GameModsSection g={g} installedNames={(proxy?.mods ?? []).map((m) => m.id)}
              installed={g.family === 'eswc' || g.family === 'legacy' ? <ProxyModList g={g} /> : <p className="dim small">{t('game.noLoader')}</p>}
              actions={<button className="btn ghost sm" onClick={() => go('skins')}>{t('skins.title')}</button>}
              footer={<GameCompanions g={g} profile={profile} />} />
          )}
          {g.installed && <ModUpdates game={g.id} />}
          {/* Extras below the mods: optional looks and add-ons of the game (hidden when none applies). */}
          {(g.id === 'tmnf' || g.id === 'tmuf') && g.installed && (
            <section className="panel game-extras">
              <SectionHead title={t('game.extras')} />
              {g.id === 'tmuf' && <HighlandsSwitch g={g} />}
              <SkidMarks g={g} />
            </section>
          )}

          {isNative && (g.family === 'eswc' || g.family === 'legacy') && qGameOf(g.id) && (
            <section className="panel"><LiveServers games={[qGameOf(g.id)!]} compact title={t('nav.servers')} /></section>
          )}
        </div>
        <div className="col side">
          {g.family === 'eswc' && <EswcPanel g={g} />}
          {isNative && <LinuxGameSetupCard game={g.id} />}
          {g.installed && g.family !== 'console' && <InstallationsCard g={g} />}
          {g.installed && <InstallInfoPanel g={g} profile={profile} />}
          {g.installed && g.family !== 'console' && <HealthCheckCard game={g.id} />}
          {g.installed && g.family !== 'console' && <HistoryCard game={g.id} />}
          {g.installed && g.family !== 'console' && <PerfPanel game={g.id} profile={profile?.name} />}
          <Recent g={g} />
          {g.id === 'tmuf' && <UnitedHint />}
          {!g.installed && (g.family === 'classic' || g.family === 'console') && <WhereToGet g={g} />}
          {/* ManiaPlanet found, this title pack missing: one hint with Folder and Scan (the hero's Get button
              scrolls here instead of showing the same text as a toast). */}
          {!g.installed && g.family === 'maniaplanet' && g.install && (
            <section className="panel hint-card" id="mp-pack">
              <SectionHead title={t('library.mpPackMissing')} />
              <p className="small">{t('get.mpAddIn', { title: g.short })}</p>
              <div className="row-btns">
                {isNative && backend.openManiaPlanet && <button className="btn primary sm" onClick={() => {
                  // ManiaPlanet's own menu adds the title; scan again once it is closed.
                  void backend.openManiaPlanet!(g.install!.path).then(() => backend.rescan!()).then(() => hub.toast({ message: t('library.scanned') })).catch((e) => hub.toast({ ok: false, message: String(e) }));
                }}><Play size={14} /> {t('get.openMp')}</button>}
                {isNative && <button className="btn ghost sm" onClick={() => backend.reveal?.(g.install!.path)}><FolderOpen size={14} /> {t('common.folder')}</button>}
                <button className="btn ghost sm" onClick={() => { void backend.rescan!().then(() => hub.toast({ message: t('library.scanned') })); }}><RefreshCw size={14} /> {t('library.scan')}</button>
              </div>
            </section>
          )}
          {!g.installed && g.family !== 'classic' && g.family !== 'console' && !(g.family === 'maniaplanet' && g.install) && (
            <section className="panel">
              <SectionHead title={t('common.notInstalled')} />
              <p className="dim">{g.note ? t(g.note) : g.titleId ? t('game.getPack') : t('game.getGame')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
