// Classic and console games on the game page: the emulator card (DS/Wii), the first TrackMania's
// "no mods" card, "Where do I get it?", the Steam fix for Nations/United Forever, the
// "Recommended for your game" card (Steam fix, TrackMania Highlands, Horizon Client) and the
// TrackMania United (2006) hint. Rust side: src-tauri/src/classiccmds.rs. Nothing here starts,
// downloads or installs anything without a click.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, Check, Cpu, Disc3, Download, ExternalLink, FileSearch, FolderOpen, Gamepad2, Loader2, Mountain, ShieldCheck, Sparkles, Undo2, Wrench, X } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { tp, useT } from '../i18n';
import { go, tmlName, useHubState } from '../state';
import type { GameView } from '../data/types';
import { coversOnline, GetButton, SectionHead, Toggle, useCachedImage } from './common';
import { igdbCoverUrl } from '@tm-hub/shared/covers';
import '../styles-classics.css';

const DOLPHIN_GUIDE = 'https://dolphin-emu.org/docs/guides/ripping-games/';
const DS_GUIDE = 'https://dumping.guide/carts/nintendo/ds';
const MB = (n: number) => (n / 1e6).toFixed(1) + ' MB';
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

// ------------------------------------------------------------------ consoles

interface EmuStatus { emu: 'dolphin' | 'melonDs'; name: string; source: '' | 'picked' | 'downloaded' | 'found'; exe: string | null; version: string; downloadUrl: string; downloadSize: number; downloadNote: string }
interface DumpInfo { path: string; format: string; code: string; title: string; game: string | null; size: number }
interface ConsoleGameStatus { game: { id: string; name: string; platform: 'ds' | 'wii'; emu: string }; dump: DumpInfo | null; dumpError: string | null; texturesDir: string | null }
interface ConsoleStatus { games: ConsoleGameStatus[]; dolphin: EmuStatus; melonds: EmuStatus; resolution: number; textures: boolean }

/** Sample for the browser preview (nothing set up). */
const PREVIEW: ConsoleStatus = {
  games: [],
  dolphin: { emu: 'dolphin', name: 'Dolphin', source: '', exe: null, version: '2609b', downloadUrl: 'https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-x64.7z', downloadSize: 20028240, downloadNote: '' },
  melonds: { emu: 'melonDs', name: 'melonDS', source: '', exe: null, version: '1.1', downloadUrl: 'https://github.com/melonDS-emu/melonDS/releases/download/1.1/melonDS-1.1-windows-x86_64.zip', downloadSize: 19484283, downloadNote: '' },
  resolution: 0, textures: false,
};

function useConsoleStatus(): [ConsoleStatus | null, () => Promise<void>] {
  const [st, setSt] = useState<ConsoleStatus | null>(isNative ? null : PREVIEW);
  const load = useCallback(async () => {
    if (!isNative) return;
    try { setSt(await invoke<ConsoleStatus>('console_status')); } catch { setSt(PREVIEW); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return [st, load];
}

const RESOLUTIONS = [0, 1, 2, 3, 4, 6];

export function ConsoleCard({ g }: { g: GameView }) {
  const hub = useHubState();
  const t = useT();
  const [st, reload] = useConsoleStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const platform = g.console?.platform ?? 'ds';
  const emuKey = g.console?.emulator ?? 'melonds';
  const emu = st ? (emuKey === 'dolphin' ? st.dolphin : st.melonds) : null;
  const mine = st?.games.find((x) => x.game.id === g.id);
  const refresh = async () => { await reload(); if (isNative) await backend.rescan(); };
  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try { await f(); await refresh(); } catch (e) { hub.toast({ ok: false, message: String(e) }); } finally { setBusy(null); }
  };
  const srcText = emu?.source ? t('console.src.' + emu.source) : '';
  const steps = platform === 'wii' ? ['1', '2', '3', '4'] : ['1', '2', '3'];
  return (
    <section className="panel console-card" id="console-setup">
      <SectionHead title={t('console.title', { emu: emu?.name ?? (emuKey === 'dolphin' ? 'Dolphin' : 'melonDS') })} sub={t('console.platform.' + platform)} />
      <ol className="cs-steps">
        <li className={emu?.exe ? 'done' : ''}>
          <div className="cs-head"><Cpu size={16} /> <b>{t('console.step.emu')}</b></div>
          {emu?.exe
            ? <div className="small"><Check size={13} className="ok-ic" /> {srcText} <span className="mono dim ellip cs-path" title={emu.exe}>{emu.exe}</span></div>
            : <div className="dim small">{t('console.emuMissing', { emu: emu?.name ?? '' })}</div>}
          {emu && <div className="row-btns">
            {emu.source !== 'downloaded' && <button className="btn primary sm" disabled={!!busy || !isNative} onClick={() => act('dl', () => invoke('console_emulator_install', { emu: emuKey }))}>
              {busy === 'dl' ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {busy === 'dl' ? t('console.downloading') : t('console.download', { emu: emu.name, v: emu.version })}
            </button>}
            <button className="btn ghost sm" disabled={!!busy || !isNative} onClick={() => act('pick', () => invoke('console_emulator_pick', { emu: emuKey }))}><FileSearch size={14} /> {t('console.pickExe', { exe: emuKey === 'dolphin' ? 'Dolphin.exe' : 'melonDS.exe' })}</button>
            {emu.source === 'picked' && <button className="btn ghost sm" disabled={!!busy} onClick={() => act('forget', () => invoke('console_emulator_forget', { emu: emuKey }))}>{t('console.forget')}</button>}
          </div>}
          {emu && emu.source !== 'downloaded' && <div className="dim tiny">{t('console.downloadNote', { host: host(emu.downloadUrl), size: MB(emu.downloadSize) })}</div>}
        </li>
        <li className={mine?.dump ? 'done' : ''}>
          <div className="cs-head"><Disc3 size={16} /> <b>{t('console.step.dump')}</b></div>
          <p className="small">{t('console.dumpIntro.' + platform)}</p>
          <ol className="cs-sub small">{steps.map((n) => <li key={n}>{t(`console.dumpStep.${platform}.${n}`)}</li>)}</ol>
          <div className="row-btns">
            <button className="btn ghost sm" onClick={() => backend.openExternal(platform === 'wii' ? DOLPHIN_GUIDE : DS_GUIDE)}><ExternalLink size={14} /> {t('console.guide', { site: platform === 'wii' ? 'dolphin-emu.org' : 'dumping.guide' })}</button>
          </div>
          <div className="dim tiny cs-legal"><ShieldCheck size={12} /> {t('console.noRoms')}</div>
        </li>
        <li className={mine?.dump ? 'done' : ''}>
          <div className="cs-head"><FileSearch size={16} /> <b>{t('console.step.file')}</b></div>
          {mine?.dump
            ? <div className="small"><Check size={13} className="ok-ic" /> {t('console.fileOk', { code: mine.dump.code, format: mine.dump.format.toUpperCase(), size: MB(mine.dump.size) })} <span className="mono dim ellip cs-path" title={mine.dump.path}>{mine.dump.path}</span></div>
            : <div className="dim small">{t('console.fileHint.' + platform)}</div>}
          {mine?.dumpError && <div className="small bad-text"><AlertTriangle size={13} /> {mine.dumpError}</div>}
          <div className="row-btns">
            <button className="btn ghost sm" disabled={!!busy || !isNative} onClick={() => act('dump', () => invoke('console_dump_pick', { game: g.id }))}><Gamepad2 size={14} /> {mine?.dump ? t('console.change') : t('console.pickFile')}</button>
            {(mine?.dump || mine?.dumpError) && <button className="btn ghost sm" disabled={!!busy} onClick={() => act('clear', () => invoke('console_dump_clear', { game: g.id }))}>{t('common.remove')}</button>}
          </div>
        </li>
        <li className={g.installed ? 'done' : ''}>
          <div className="cs-head"><Sparkles size={16} /> <b>{t('console.step.play')}</b></div>
          <div className="small dim">{g.installed ? t('console.ready', { emu: emu?.name ?? '' }) : t('console.notReady')}</div>
        </li>
      </ol>
      {platform === 'wii' && st && (
        <div className="cs-options">
          <h4 className="gm-sub">{t('console.options')}</h4>
          <div className="setrow">
            <div className="grow"><b>{t('console.resolution')}</b><div className="dim small">{t('console.resolutionTip')}</div></div>
            <select className="input sm" value={st.resolution} disabled={!isNative} onChange={(e) => act('res', () => invoke('console_options', { resolution: Number(e.target.value), textures: st.textures }))}>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{t('console.res.' + r)}</option>)}
            </select>
          </div>
          <div className="setrow">
            <div className="grow"><b>{t('console.textures')}</b><div className="dim small">{t('console.texturesTip', { id: mine?.dump?.code ?? 'R6RPHH' })}</div></div>
            <Toggle on={st.textures} label={t('console.textures')} onChange={() => act('tex', () => invoke('console_options', { resolution: st.resolution, textures: !st.textures }))} />
          </div>
          {mine?.texturesDir && <button className="btn ghost sm" onClick={() => act('texdir', () => invoke('console_textures_folder', { game: g.id }))} title={mine.texturesDir}><FolderOpen size={14} /> {t('console.openTextures')}</button>}
        </div>
      )}
      <p className="dim small cs-online">{t('console.online')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ TrackMania (2003)

export function ClassicCard({ g }: { g: GameView }) {
  const t = useT();
  return (
    <section className="panel">
      <SectionHead title={t('classic.noModsTitle')} />
      <p className="small">{t('classic.noModsText')}</p>
      {g.install?.note && <p className="dim small">{g.install.note}</p>}
      {g.installed && <button className="btn ghost sm" onClick={() => go('media')}><FolderOpen size={14} /> {t('classic.screenshots')}</button>}
    </section>
  );
}

/** "Where do I get it?" for the games without a store (side column of the game page). */
export function WhereToGet({ g }: { g: GameView }) {
  const t = useT();
  return (
    <section className="panel" id="where-get">
      <SectionHead title={t('where.title')} />
      <p className="small">{t('where.' + g.id)}</p>
      {g.family === 'console' && <button className="btn ghost sm" onClick={() => scrollTo('console-setup')}>{t('where.toSetup')}</button>}
    </section>
  );
}

// ------------------------------------------------------------------ Steam fix

interface SteamFixStatus { steam: boolean; iniFound: boolean; distro: string | null; iniFixed: boolean; backup: boolean; updateReady: boolean; updateUrl: string; updateSize: number }

export const isSteamPath = (p?: string | null) => !!p && /[\\/]steamapps[\\/]/i.test(p);

export function SteamFixCard({ g }: { g: GameView }) {
  const hub = useHubState();
  const t = useT();
  const [st, setSt] = useState<SteamFixStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const load = useCallback(() => {
    if (isNative) invoke<SteamFixStatus>('steamfix_status', { game: g.id }).then(setSt).catch(() => setSt(null));
    else setSt({ steam: true, iniFound: true, distro: 'AGOBM', iniFixed: false, backup: false, updateReady: false, updateUrl: 'http://files2.trackmaniaforever.com/TmUnitedForever_Update_2010-03-15_Setup.exe', updateSize: 22430056 });
  }, [g.id]);
  useEffect(load, [load, g.install?.path]);
  useEffect(() => {
    if (!isNative) return;
    const offs = [
      listen<{ game: string; received: number; total: number | null }>('steamfix-download', (e) => { if (e.payload.game === g.id && e.payload.total) setPct(Math.round((e.payload.received / e.payload.total) * 100)); }),
      listen<{ game: string; code: number | null; error: string | null }>('steamfix-done', async (e) => {
        if (e.payload.game !== g.id) return;
        setBusy(null);
        hub.toast(e.payload.error ? { ok: false, message: t('steamfix.failed', { error: e.payload.error }) } : { message: t('steamfix.finished') });
        await backend.rescan();
        load();
      }),
    ];
    return () => { offs.forEach((p) => p.then((f) => f())); };
  }, [g.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st?.steam) return null;
  const call = async (key: string, cmd: string, keepBusy = false) => {
    setBusy(key);
    try {
      const r = await invoke<SteamFixStatus | null>(cmd, { game: g.id });
      if (r) setSt(r);
      if (!keepBusy) setBusy(null);
    } catch (e) { setBusy(null); setPct(null); hub.toast({ ok: false, message: String(e) }); }
  };
  return (
    <section className="panel steamfix" id="steam-fix">
      <SectionHead title={<><Wrench size={18} /> {t('steamfix.title')}</>} />
      <p className="small">{t('steamfix.intro')}</p>
      <div className="tool-card sf-step">
        <span className={'sf-num' + (st.iniFixed ? ' ok' : '')}>{st.iniFixed ? <Check size={14} /> : 1}</span>
        <div className="grow">
          <b>{t('steamfix.step1')}</b>
          <div className="dim small">{!st.iniFound ? t('steamfix.notFound') : st.iniFixed ? t('steamfix.done1') : t('steamfix.step1Text', { v: st.distro ?? '-' })}</div>
        </div>
        {st.iniFound && !st.iniFixed && <button className="btn primary sm" disabled={!!busy || !isNative} onClick={() => call('ini', 'steamfix_apply_ini')}><Wrench size={14} /> {t('steamfix.apply')}</button>}
        {st.iniFixed && st.backup && <button className="btn ghost sm" disabled={!!busy} onClick={() => call('undo', 'steamfix_undo_ini')}><Undo2 size={14} /> {t('steamfix.undo')}</button>}
      </div>
      <div className="tool-card sf-step">
        <span className="sf-num">2</span>
        <div className="grow">
          <b>{t('steamfix.step2')}</b>
          <div className="dim small">{st.updateReady ? t('steamfix.ready') : t('steamfix.step2Text', { size: MB(st.updateSize), host: host(st.updateUrl) })}</div>
        </div>
        {!st.updateReady
          ? <button className="btn ghost sm" disabled={!!busy || !st.iniFixed || !isNative} title={!st.iniFixed ? t('steamfix.step1First') : undefined} onClick={async () => { setPct(0); await call('dl', 'steamfix_download'); setPct(null); }}>
              {busy === 'dl' ? <><Loader2 size={14} className="spin" /> {pct ?? 0} %</> : <><Download size={14} /> {t('steamfix.download')}</>}
            </button>
          : <button className="btn primary sm" disabled={!!busy || !isNative} onClick={() => call('run', 'steamfix_run', true)}>
              {busy === 'run' ? <><Loader2 size={14} className="spin" /> {t('steamfix.running')}</> : <><ShieldCheck size={14} /> {t('steamfix.run')}</>}
            </button>}
      </div>
      <p className="dim tiny">{t('steamfix.noUndoUpdate')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ recommended

interface ZipSpec { page: string; fileName: string; size: number | null; md5: string; root: string }
interface HighlandsInfo { spec: ZipSpec; downloads: string | null; found: string[] }
interface ZipCheck { path: string; size: number; md5: string; verified: boolean; needsConfirm: boolean; files: string[]; unpackedBytes: number; notes: [string, string][] }

function HighlandsFlow({ onClose }: { onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const [info, setInfo] = useState<HighlandsInfo | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [check, setCheck] = useState<ZipCheck | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => { if (isNative) invoke<HighlandsInfo>('highlands_info', { sinceMs: null }).then(setInfo).catch(() => undefined); }, []);
  const inspect = async (path: string) => {
    try { setCheck(await invoke<ZipCheck>('highlands_check', { path })); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
  };
  // Watching Downloads: every 3 s for a ZIP that appeared after "Open ModDB" was clicked.
  useEffect(() => {
    if (watching === null || check) return;
    timer.current = window.setInterval(async () => {
      const i = await invoke<HighlandsInfo>('highlands_info', { sinceMs: watching }).catch(() => null);
      if (i?.found[0]) { setWatching(null); void inspect(i.found[0]); }
    }, 3000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [watching, check]); // eslint-disable-line react-hooks/exhaustive-deps
  const install = async () => {
    if (!check) return;
    setBusy(true);
    try {
      const id = await invoke<string | null>('highlands_install', { path: check.path, confirmed: check.needsConfirm });
      setDone(id ?? '');
      hub.toast({ message: t('highlands.done') });
    } catch (e) { hub.toast({ ok: false, message: String(e) }); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (!done) return;
    const r = await invoke<{ ok: boolean; code: string }>('history_undo', { id: done }).catch((e) => ({ ok: false, code: String(e) }));
    hub.toast(r.ok ? { message: t('highlands.undone') } : { ok: false, message: r.code });
    if (r.ok) { setDone(null); setCheck(null); }
  };
  const page = info?.spec.page || 'https://www.moddb.com/mods/trackmania-highlands/downloads';
  return (
    <div className="hl-flow">
      <div className="sf-step tool-card">
        <span className="sf-num">1</span>
        <div className="grow"><b>{t('highlands.step1')}</b><div className="dim small">{t('highlands.step1Text')}</div></div>
        <button className="btn ghost sm" onClick={() => { setWatching(Date.now() - 5000); backend.openExternal(page); }}><ExternalLink size={14} /> ModDB</button>
      </div>
      <div className="sf-step tool-card">
        <span className="sf-num">2</span>
        <div className="grow">
          <b>{t('highlands.step2')}</b>
          <div className="dim small">{check ? t('highlands.checked', { file: check.path.split(/[\\/]/).pop() ?? '', size: MB(check.size), md5: check.md5 }) : watching !== null ? t('highlands.watching', { folder: info?.downloads ?? 'Downloads' }) : t('highlands.step2Text')}</div>
        </div>
        {watching !== null && !check && <Loader2 size={16} className="spin" />}
        <button className="btn ghost sm" disabled={!isNative} onClick={async () => { const p = await invoke<string | null>('highlands_pick'); if (p) { setWatching(null); void inspect(p); } }}><FileSearch size={14} /> {t('highlands.pick')}</button>
      </div>
      {check && (
        <div className="sf-step tool-card">
          <span className={'sf-num' + (done !== null ? ' ok' : '')}>{done !== null ? <Check size={14} /> : 3}</span>
          <div className="grow">
            <b>{t('highlands.step3')}</b>
            <div className={'small ' + (check.verified ? 'ok-text' : 'warn-text')}>{check.verified ? t('highlands.verified') : t('highlands.unverified')}</div>
            <div className="dim small">{tp('highlands.files', check.files.length, { n: check.files.length })} {t('highlands.unpacked', { size: MB(check.unpackedBytes) })}</div>
            <div className="dim small">{t('highlands.backupNote')}</div>
            {check.notes.map(([name, text]) => (
              <details key={name} className="hl-note small">
                <summary>{name}</summary>
                <pre>{text}</pre>
              </details>
            ))}
          </div>
          {done === null
            ? <button className="btn primary sm" disabled={busy} onClick={install}>{busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {check.verified ? t('highlands.install') : t('highlands.installChecked')}</button>
            : <button className="btn ghost sm" onClick={undo}><Undo2 size={14} /> {t('steamfix.undo')}</button>}
        </div>
      )}
      <button className="linkish small" onClick={onClose}>{t('common.close')}</button>
    </div>
  );
}

/** United Forever with Highlands in the folder: on/off without uninstalling (renames its environment
 *  collection and car, as the Highlands readme describes). */
export function HighlandsSwitch({ g }: { g: GameView }) {
  const t = useT();
  const hub = useHubState();
  const [st, setSt] = useState<{ installed: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isNative && g.id === 'tmuf' && g.installed) invoke<{ installed: boolean; enabled: boolean } | null>('highlands_state').then(setSt).catch(() => setSt(null));
  }, [g.id, g.installed, hub.downloads.length]);
  if (!st?.installed) return null;
  const flip = async () => {
    const want = !st.enabled;
    setSt({ ...st, enabled: want });
    setBusy(true);
    try { setSt(await invoke('highlands_set_enabled', { on: want })); } catch (e) { setSt({ ...st }); hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  return (
    <section className="panel hl-switch">
      <div className="tool-card sg-row">
        <Mountain size={18} />
        <div className="grow"><b>TrackMania Highlands</b><div className="dim small">{st.enabled ? t('highlands.onText') : t('highlands.offText')}</div></div>
        <button className="linkish small" onClick={() => backend.openExternal('https://www.moddb.com/mods/trackmania-highlands')}><ExternalLink size={13} /> ModDB</button>
        <Toggle on={st.enabled} label="TrackMania Highlands" onChange={() => { if (!busy) void flip(); }} />
      </div>
    </section>
  );
}

type SuggestionId = 'steamfix' | 'highlands' | 'horizon';

/** Small card at the top of an installed game's page. Nothing is ticked or installed by itself. */
export function SuggestionsCard({ g, steamFixDone }: { g: GameView; steamFixDone?: boolean }) {
  const t = useT();
  const [dismissed, setDismissed] = useState<string[]>(() => (backend.info?.()?.settings as { suggestionsDismissed?: string[] } | undefined)?.suggestionsDismissed ?? []);
  const [open, setOpen] = useState<SuggestionId | null>(null);
  const [sf, setSf] = useState<SteamFixStatus | null>(null);
  const hub = useHubState();
  // Already done (Highlands in the folder, Horizon Client on for this profile, Steam fix applied): not suggested again.
  const [done, setDone] = useState<string[]>([]);
  const profile = g.family === 'forever' ? tmlName(hub.profileFor(g.id)) : null;
  const steam = (g.id === 'tmnf' || g.id === 'tmuf') && isSteamPath(g.install?.path);
  useEffect(() => {
    if (steam && isNative) invoke<SteamFixStatus>('steamfix_status', { game: g.id }).then(setSf).catch(() => setSf(null));
  }, [steam, g.id, steamFixDone]);
  useEffect(() => {
    if (isNative && g.installed) invoke<string[]>('suggestions_done', { game: g.id, profile }).then(setDone).catch(() => setDone([]));
  }, [g.id, g.installed, profile, steamFixDone, hub.downloads.length]);
  if (!g.installed) return null;
  const items: { id: SuggestionId; icon: JSX.Element; anchor?: string }[] = [];
  if (steam && !sf?.iniFixed) items.push({ id: 'steamfix', icon: <Wrench size={18} />, anchor: 'steam-fix' });
  if (g.id === 'tmuf') items.push({ id: 'highlands', icon: <Mountain size={18} /> });
  if (['tmnf', 'tmuf', 'tmn-eswc', 'tm-sunrise', 'tm-original'].includes(g.id)) items.push({ id: 'horizon', icon: <Sparkles size={18} />, anchor: 'horizon-client' });
  const visible = items.filter((i) => !dismissed.includes(`${g.id}:${i.id}`) && !done.includes(i.id));
  if (!visible.length) return null;
  const dismiss = async (id: SuggestionId) => {
    const key = `${g.id}:${id}`;
    setDismissed((d) => [...d, key]);
    if (isNative) await invoke('suggestion_dismiss', { key }).catch(() => undefined);
  };
  return (
    <section className="panel suggest-card">
      <SectionHead title={t('suggest.title')} />
      {visible.map((i) => (
        <div key={i.id}>
          <div className="tool-card sg-row">
            {i.icon}
            <div className="grow"><b>{t('suggest.' + i.id)}{i.id === 'horizon' && <span className="pill tiny sg-pill">{t('suggest.recommended')}</span>}</b><div className="dim small">{t('suggest.' + i.id + 'Text')}</div></div>
            <button className="btn ghost sm" onClick={() => (i.anchor ? scrollTo(i.anchor) : setOpen(open === i.id ? null : i.id))}>{t('suggest.show')}</button>
            <button className="bbtn sm" aria-label={t('suggest.hide')} title={t('suggest.hide')} onClick={() => dismiss(i.id)}><X size={14} /></button>
          </div>
          {open === 'highlands' && i.id === 'highlands' && <HighlandsFlow onClose={() => setOpen(null)} />}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ TrackMania United (2006)

/** "Bought United?" hint: the free update to United Forever (official setup or Steam). */
export function UnitedHint({ compact = false }: { compact?: boolean }) {
  const hub = useHubState();
  const t = useT();
  const tmuf = hub.game('tmuf');
  if (!tmuf || tmuf.installed) return null;
  return (
    <div className={'united-hint' + (compact ? ' compact' : ' panel')}>
      <UnitedCover />
      <div className="grow">
        <b>{t('united.title')}</b>
        <p className="small">{t('united.text')}</p>
        <div className="row-btns">
          {isNative && <GetButton game={tmuf} size="sm" />}
          <button className="btn ghost sm" onClick={() => backend.openExternal('https://store.steampowered.com/app/7200/')}><ExternalLink size={14} /> Steam</button>
        </div>
      </div>
    </div>
  );
}

function UnitedCover() {
  // TrackMania United (2006) box art from IGDB (co6kba, shared cover table), through the app's picture cache.
  const src = useCachedImage(coversOnline() ? igdbCoverUrl('tm-united-2006') : null);
  return src ? <img className="united-cover" src={src} alt="" /> : <span className="united-cover ph" aria-hidden>TMU</span>;
}
