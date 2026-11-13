// Performance panel of a game page: Windows per-exe settings and the game's graphics config, the
// benchmark hand-over to Horizon Host, the replay archive and "Record start".
// Rust side: optimize.rs, syscfg.rs, perfbench.rs, replayarchive.rs, startwatch.rs. Docs: docs/optimize.md.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Gauge, Loader2, Play, RotateCcw, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { tr, useT } from '../i18n';
import { Modal } from './Modal';
import { loadPref, savePref, useHubState } from '../state';
import { SectionHead, Toggle } from './common';

interface Change { kind: string; name: string; old: string | null; new: string | null }
interface OptState { supported: boolean; reason: string | null; exe: string | null; fso: boolean; dpi: boolean; gpu: boolean; canUndo: boolean }
interface Display { format: string; width: number; height: number; windowPreset: number; colorDepth: number; antialiasing: number; refresh: number; vsync: boolean; fullscreen: boolean; textures: number | null; shadows: number | null }
interface SysState { path: string; display: Display; writable: boolean; tips: string[]; canUndo: boolean }
interface FieldDiff { field: string; old: string; new: string }
interface Summary { file: string; label: string; run: number | null; avgFps: number | null; low1Fps: number | null; low01Fps: number | null; stutters: number | null }
interface LabelStat { label: string; runs: number; avgFps: number | null; low1Fps: number | null; low01Fps: number | null; diffAvg: number | null; diffLow1: number | null; diffLow01: number | null }
interface BenchState { available: boolean; dir: string | null; lastMap: string | null; results: Summary[]; compare: LabelStat[] }
interface ArchState { replaysDir: string; archiveDir: string; count: number; bytes: number; archivedCount: number; archivedBytes: number; days: number; keep: number; canUndo: boolean }
interface ArchPlan { count: number; bytes: number; sample: string[] }
interface Report { moved: number; bytes: number; skipped: string[] }
interface Hit { place: string; path: string; rel: string; size: number; mtimeMs: number; player: string | null; time: string | null; env: string | null }
interface WatchRow { file: string; game: string; started: string; exitMs: number | null; summary: { seconds: number; hungMs: number; longestHungMs: number; longestIdleMs: number; cpuMs: number; readMb: number; fsEvents: number } }
interface WatchState { supported: boolean; on: boolean; rows: WatchRow[] }
interface Action { ok: boolean; message: string }

const AA = ['off', '2x', '4x', '6x', '8x', '16x'];
/** "off" in the player's language, the rest as they are (2x, 4x, ...). */
const aaLabel = (a: string) => (a === 'off' ? tr('perf.aaOff') : a);
const mb = (b: number) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1);
const f1 = (n: number | null) => (n == null ? '-' : n.toFixed(1));
const pct = (n: number | null) => (n == null ? '' : (n > 0 ? '+' : '') + n.toFixed(1) + ' %');
const num = (s: string, d: number) => { const n = parseInt(s, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

function Msg({ text, bad }: { text: string; bad?: boolean }) {
  return text ? <p className={'small' + (bad ? ' warn' : ' dim')}>{text}</p> : null;
}

function Busy({ on }: { on: boolean }) {
  return on ? <Loader2 size={14} className="spin" /> : null;
}

/** One block of a tab: a small head (title, badge) and its rows. Styles: styles-perf.css. */
function Block({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return <div className="perf-block"><div className="perf-head"><h3>{title}</h3>{badge}</div>{children}</div>;
}

/** A labelled option: text on the left (with an optional dim line), its control on the right. */
function Opt({ label, note, tip, children }: { label?: ReactNode; note?: ReactNode; tip?: string; children?: ReactNode }) {
  return (
    <div className="perf-opt" title={tip}>
      <div className="perf-opt-text">{label && <span className="perf-label">{label}</span>}{note && <span className="dim small">{note}</span>}</div>
      {children}
    </div>
  );
}

/** A row of buttons (and inputs) with one control height (styles-controls.css `ctl-bar sm`). */
function Actions({ children }: { children: ReactNode }) {
  return <div className="ctl-bar sm perf-actions">{children}</div>;
}

const Experimental = ({ tip }: { tip: string }) => <span className="pill tiny muted" title={tip}>{tr('perf.badge.experimental')}</span>;

// ------------------------------------------------------------------ Optimize

function Optimize({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<OptState | null>(null);
  const [want, setWant] = useState({ fso: false, dpi: false, gpu: false });
  const [ask, setAsk] = useState<Change[] | null>(null);
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  const load = useCallback(async () => {
    const s = await invoke<OptState>('optimize_state', { gameId: game });
    setSt(s);
    setWant({ fso: s.fso, dpi: s.dpi, gpu: s.gpu });
  }, [game]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  const fail = (e: unknown) => { setBad(true); setMsg(String(e)); };
  const plan = async () => {
    setMsg('');
    try {
      const c = await invoke<Change[]>('optimize_plan', { gameId: game, want });
      if (c.length === 0) { setBad(false); setMsg(t('perf.noChange')); } else setAsk(c);
    } catch (e) { fail(e); }
  };
  const apply = async () => {
    setAsk(null);
    try { await invoke('optimize_apply', { gameId: game, want }); setBad(false); setMsg(t('perf.done')); await load(); } catch (e) { fail(e); }
  };
  const undo = async () => {
    try { await invoke('optimize_undo', { gameId: game }); setBad(false); setMsg(t('perf.undone')); await load(); } catch (e) { fail(e); }
  };
  if (!st) return null;
  const dirty = st.fso !== want.fso || st.dpi !== want.dpi || st.gpu !== want.gpu;
  const sw = (k: 'fso' | 'dpi' | 'gpu') => (
    <Opt label={t('perf.' + k)} tip={t('perf.' + k + '.tip')}><Toggle on={want[k]} label={t('perf.' + k)} title={t('perf.' + k + '.tip')} onChange={() => setWant({ ...want, [k]: !want[k] })} /></Opt>
  );
  return (
    <Block title={t('perf.win.title')}>
      {!st.supported ? <p className="dim small">{st.reason}</p> : (
        <>
          {sw('fso')}
          {sw('dpi')}
          {sw('gpu')}
          <Actions>
            <button className={'btn sm ' + (dirty ? 'primary' : 'ghost')} disabled={!dirty} onClick={plan}>{t('perf.apply')}</button>
            <button className="btn ghost sm" disabled={!st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.undo')}</button>
          </Actions>
        </>
      )}
      <Msg text={msg} bad={bad} />
      {ask && (
        <Modal title={t('perf.confirm')} onClose={() => setAsk(null)} actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn" onClick={apply}>{t('perf.apply')}</button></>}>
          <p className="small dim">{st.exe}</p>
          {ask.map((c) => (
            <div key={c.kind} className="small">
              <b>{c.kind === 'layers' ? t('perf.reg.layers') : t('perf.reg.gpu')}</b>
              <div><code>{c.old ?? t('perf.absent')}</code> &rarr; <code>{c.new ?? t('perf.absent')}</code></div>
            </div>
          ))}
        </Modal>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Game config

function GameConfig({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<SysState | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<{ fullscreen: boolean; vsync: boolean; antialiasing: number } | null>(null);
  const [ask, setAsk] = useState<FieldDiff[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const s = await invoke<SysState>('syscfg_state', { gameId: game });
      setSt(s);
      setErr('');
      setEdit({ fullscreen: s.display.fullscreen, vsync: s.display.vsync, antialiasing: s.display.antialiasing });
    } catch (e) { setSt(null); setErr(String(e)); }
  }, [game]);
  useEffect(() => { load(); }, [load]);
  const plan = async () => {
    setMsg('');
    try {
      const d = await invoke<FieldDiff[]>('syscfg_plan', { gameId: game, edit });
      if (d.length === 0) setMsg(t('perf.noChange')); else setAsk(d);
    } catch (e) { setMsg(String(e)); }
  };
  const apply = async () => {
    setAsk(null);
    try { await invoke('syscfg_apply', { gameId: game, edit }); setMsg(t('perf.done')); await load(); } catch (e) { setMsg(String(e)); }
  };
  const undo = async () => {
    try { await invoke('syscfg_undo', { gameId: game }); setMsg(t('perf.undone')); await load(); } catch (e) { setMsg(String(e)); }
  };
  if (err) return <Block title={t('perf.cfg.title')}><p className="dim small">{err}</p></Block>;
  if (!st || !edit) return null;
  const d = st.display;
  const tex = ['perf.tex.0', 'perf.tex.1', 'perf.tex.2', 'perf.tex.3'];
  const sh = ['perf.sh.0', 'perf.sh.1', 'perf.sh.2', 'perf.sh.3', 'perf.sh.4', 'perf.sh.5'];
  const dirty = edit.fullscreen !== d.fullscreen || edit.vsync !== d.vsync || edit.antialiasing !== d.antialiasing;
  return (
    <Block title={t('perf.cfg.title')} badge={st.writable && <Experimental tip={t('perf.cfg.untested')} />}>
      <p className="dim small">
        {d.width} x {d.height}, {d.fullscreen ? t('perf.cfg.full') : t('perf.cfg.window')}, V-Sync {d.vsync ? t('perf.on') : t('perf.off')}, {t('perf.cfg.aa')}: {aaLabel(AA[d.antialiasing] ?? String(d.antialiasing))}
        {d.textures != null && <>, {t('perf.cfg.textures')}: {t(tex[d.textures] ?? 'perf.tex.0')}</>}
        {d.shadows != null && <>, {t('perf.cfg.shadows')}: {t(sh[d.shadows] ?? 'perf.sh.0')}</>}
      </p>
      {st.tips.length > 0 && <ul className="perf-tips small">{st.tips.map((x) => <li key={x}>{t('perf.tip.' + x)}</li>)}</ul>}
      {st.writable ? (
        <>
          <Opt label={t('perf.cfg.fullscreen')}><Toggle on={edit.fullscreen} label={t('perf.cfg.fullscreen')} onChange={() => setEdit({ ...edit, fullscreen: !edit.fullscreen })} /></Opt>
          <Opt label="V-Sync"><Toggle on={edit.vsync} label="V-Sync" onChange={() => setEdit({ ...edit, vsync: !edit.vsync })} /></Opt>
          <Opt label={t('perf.cfg.aa')}>
            <select className="text-in" value={edit.antialiasing} aria-label={t('perf.cfg.aa')} onChange={(e) => setEdit({ ...edit, antialiasing: Number(e.target.value) })}>{AA.map((a, i) => <option key={a} value={i}>{aaLabel(a)}</option>)}</select>
          </Opt>
          <Actions>
            <button className={'btn sm ' + (dirty ? 'primary' : 'ghost')} disabled={!dirty} onClick={plan}>{t('perf.apply')}</button>
            <button className="btn ghost sm" disabled={!st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.undo')}</button>
          </Actions>
        </>
      ) : <p className="dim small">{t('perf.cfg.readOnly')}</p>}
      <Msg text={msg} />
      {ask && (
        <Modal title={t('perf.confirm')} onClose={() => setAsk(null)} actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn" onClick={apply}>{t('perf.apply')}</button></>}>
          <p className="small dim">{st.path}</p>
          {ask.map((x) => <div key={x.field} className="small"><b>{t('perf.field.' + x.field)}</b>: {x.old} &rarr; {x.new}</div>)}
          <p className="small dim">{t('perf.cfg.backup')}</p>
        </Modal>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Cpu/Gpu synchro

interface SyncState { supported: boolean; reason: string | null; path: string | null; value: number | null; writable: boolean; launcher: string | null; canUndo: boolean }
/** The game's own names (its launcher shows them in English in every language), index = GpuSync value. */
const SYNC = ['None', '3 Frames', '2 Frames & Half', '2 Frames', '1 Frame & Half', '1 Frame', 'Half a frame', 'Immediate'];
const syncName = (v: number) => (SYNC[v] ?? String(v)) + (v === 7 ? ' ' + tr('v052.sync.default') : '');
/** Fired when the value changed, so the card and the recommendation on the same page read it again. */
const SYNC_EVENT = 'tmh-gpusync';
const syncChanged = () => window.dispatchEvent(new Event(SYNC_EVENT));
const SYNC_GAMES = ['tmnf', 'tmuf', 'tmn-eswc', 'tm-sunrise', 'tm-original'];

/** Game page recommendation while the game's Cpu/Gpu synchro is Immediate (the default): one click sets
 * "1 Frame" where the launcher can write the file (with Undo in the toast), else it opens the game's own
 * launcher with a hint where the setting is. Nothing changes without that click. "Not now" hides it per game. */
export function GpuSyncTip({ game }: { game: string }) {
  const t = useT();
  const hub = useHubState();
  const [st, setSt] = useState<SyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => loadPref('tmhub.syncTipHidden.' + game) === '1');
  const load = useCallback(async () => { setSt(await invoke<SyncState>('gpusync_state', { gameId: game })); }, [game]);
  useEffect(() => { setHidden(loadPref('tmhub.syncTipHidden.' + game) === '1'); }, [game]);
  useEffect(() => {
    if (!isNative || !SYNC_GAMES.includes(game)) return;
    load().catch(() => undefined);
    const on = () => { load().catch(() => undefined); };
    window.addEventListener(SYNC_EVENT, on);
    return () => window.removeEventListener(SYNC_EVENT, on);
  }, [game, load]);
  if (!isNative || hidden || !st?.supported || st.value !== 7) return null;
  const set = async () => {
    setBusy(true);
    try {
      await invoke('gpusync_apply', { gameId: game, value: 5 });
      syncChanged();
      hub.toast({ ok: true, message: t('v052.syncTip.done'), actions: [{ label: t('perf.undo'), run: () => { void invoke('syscfg_undo', { gameId: game }).then(syncChanged).catch((e) => hub.toast({ ok: false, message: String(e) })); } }] });
    } catch (e) { hub.toast({ ok: false, message: String(e) === 'notWritable' ? t('v052.sync.notWritable') : String(e) }); }
    setBusy(false);
  };
  const openLauncher = () => invoke('gpusync_open_launcher', { gameId: game }).catch((e) => hub.toast({ ok: false, message: String(e) }));
  const hide = () => { savePref('tmhub.syncTipHidden.' + game, '1'); setHidden(true); };
  return (
    <section className="panel suggest-card sync-tip">
      <div className="tool-card sg-row" title={t('v052.syncTip.tip')}>
        <Gauge size={18} />
        <div className="grow">
          <b>{t('v052.syncTip.title')}</b>
          <div className="dim small">{t('v052.syncTip.text')} {t('v052.syncTip.tip')}</div>
          {!st.writable && <div className="dim small">{t('v052.syncTip.where')}</div>}
        </div>
        {st.writable
          ? <button className="btn primary sm" disabled={busy} onClick={set} title={t('v052.syncTip.tip')}>{busy ? <Busy on /> : null} {t('v052.syncTip.set')}</button>
          : st.launcher && <button className="btn ghost sm" onClick={openLauncher}>{t('v052.sync.openLauncher')}</button>}
        <button className="bbtn sm" aria-label={t('v052.syncTip.later')} title={t('v052.syncTip.later')} onClick={hide}><X size={14} /></button>
      </div>
    </section>
  );
}

/** The game's "Cpu/Gpu synchro" (GpuSync in Default.SystemConfig.Gbx). Backend: syscfg.rs gpusync_*. */
function GpuSync({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<SyncState | null>(null);
  const [want, setWant] = useState<number | null>(null);
  const [ask, setAsk] = useState(false);
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  const load = useCallback(async () => {
    const s = await invoke<SyncState>('gpusync_state', { gameId: game });
    setSt(s);
    setWant(s.value);
  }, [game]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  useEffect(() => {
    const on = () => { load().catch(() => undefined); };
    window.addEventListener(SYNC_EVENT, on);
    return () => window.removeEventListener(SYNC_EVENT, on);
  }, [load]);
  const fail = (e: unknown) => { const s = String(e); setBad(true); setMsg(s === 'notWritable' ? t('v052.sync.notWritable') : s); };
  const apply = async () => {
    setAsk(false);
    try { await invoke('gpusync_apply', { gameId: game, value: want }); setBad(false); setMsg(t('perf.done')); await load(); syncChanged(); } catch (e) { fail(e); }
  };
  const undo = async () => {
    try { await invoke('syscfg_undo', { gameId: game }); setBad(false); setMsg(t('perf.undone')); await load(); syncChanged(); } catch (e) { fail(e); }
  };
  const openLauncher = () => invoke('gpusync_open_launcher', { gameId: game }).catch(fail);
  if (!st?.supported) return null;
  const forever = game === 'tmnf' || game === 'tmuf';
  return (
    <Block title={t('v052.sync.title')} badge={st.writable && <Experimental tip={t('perf.cfg.untested')} />}>
      {st.value == null ? <p className="dim small">{st.reason}</p> : st.writable ? (
        <Actions>
          <select className="text-in" value={want ?? st.value} onChange={(e) => setWant(Number(e.target.value))} aria-label={t('v052.sync.title')} title={t('v052.sync.tip')}>
            {SYNC.map((_, v) => <option key={v} value={v}>{syncName(v)}</option>)}
          </select>
          <button className={'btn sm ' + (want !== st.value ? 'primary' : 'ghost')} disabled={want === st.value} onClick={() => setAsk(true)}>{t('perf.apply')}</button>
          <button className="btn ghost sm" disabled={!st.canUndo} onClick={undo} title={t('perf.undo')}><RotateCcw size={14} /> {t('perf.undo')}</button>
        </Actions>
      ) : (
        <Opt label={syncName(st.value)} note={t('v052.sync.readOnly')}>
          {st.launcher && <button className="btn ghost sm" onClick={openLauncher}>{t('v052.sync.openLauncher')}</button>}
        </Opt>
      )}
      <p className="dim small">{t('v052.sync.tip')}{forever ? ' ' + t('v052.sync.shared') : ''}</p>
      <Msg text={msg} bad={bad} />
      {ask && want != null && st.value != null && (
        <Modal title={t('perf.confirm')} onClose={() => setAsk(false)} actions={<><button className="btn ghost" onClick={() => setAsk(false)}>{t('common.cancel')}</button><button className="btn" onClick={apply}>{t('perf.apply')}</button></>}>
          <p className="small dim">{st.path}</p>
          <div className="small"><b>{t('v052.sync.title')}</b>: {syncName(st.value)} &rarr; {syncName(want)}</div>
          <p className="small dim">{t('perf.cfg.backup')}</p>
        </Modal>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Horizon Performance "Smoothing" (in the game)

/** One line pointing to the in-game Smoothing switches, when the Horizon Client is installed for this game. */
function SmoothingHint({ game, profile }: { game: string; profile?: string }) {
  const t = useT();
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const h = backend.horizon;
    if (!h) return;
    const forever = game === 'tmnf' || game === 'tmuf';
    const check = forever
      ? h.tmlStatus(game, profile ?? null).then((s) => s.installed.length > 0)
      : h.targets(game).then((ts) => Promise.all(ts.map((x) => h.status(game, x.dir).then((s) => !!s.installed).catch(() => false)))).then((r) => r.some(Boolean));
    check.then((x) => { if (live) setOn(x); }).catch(() => undefined);
    return () => { live = false; };
  }, [game, profile]);
  if (!on) return null;
  return <p className="small perf-hint"><Sparkles size={14} /> <span>{t('v052.smoothing')}</span></p>;
}

// ------------------------------------------------------------------ DXVK

interface DxState { supported: boolean; reason: string | null; dir: string | null; status: 'on' | 'off' | 'foreign'; version: string; admin: boolean }
interface DxPlan { dir: string; files: string[]; conf: string; version: string; cached: boolean; admin: boolean }
interface DxReport { removed: string[]; kept: string[] }

function Dxvk({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<DxState | null>(null);
  const [ask, setAsk] = useState<DxPlan | null>(null);
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setSt(await invoke<DxState>('dxvk_state', { gameId: game })); }, [game]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  // Errors from Rust are short codes ("foreignDll", "notWritable:<detail>"), the texts are here.
  const fail = (e: unknown) => {
    const s = String(e);
    const code = s.split(':')[0];
    const key = 'perf.dxvk.err.' + code;
    const txt = t(key);
    setBad(true);
    setMsg(txt === key ? s : txt);
  };
  const toggle = async (on: boolean) => {
    setMsg('');
    if (!on) {
      setBusy(true);
      try {
        // A Program Files folder: one UAC prompt removes exactly my two files (elevate.rs).
        const r = await invoke<DxReport>('dxvk_off', { gameId: game, admin: !!st?.admin });
        setBad(r.kept.length > 0);
        setMsg(r.kept.length ? t('perf.dxvk.kept', { files: r.kept.join(', ') }) : t('perf.dxvk.removed'));
        await load();
      } catch (e) { fail(e); }
      setBusy(false);
      return;
    }
    try { setAsk(await invoke<DxPlan>('dxvk_plan', { gameId: game })); } catch (e) { fail(e); }
  };
  const apply = async () => {
    const plan = ask;
    setAsk(null);
    setBusy(true);
    try { await invoke('dxvk_on', { gameId: game, admin: !!plan?.admin }); setBad(false); setMsg(t('perf.dxvk.written')); await load(); } catch (e) { fail(e); }
    setBusy(false);
  };
  if (!st) return null;
  return (
    <Block title={t('perf.dxvk.title')} badge={<Experimental tip={t('perf.dxvk.untested')} />}>
      {!st.supported ? <p className="dim small">{t('perf.dxvk.err.' + (st.reason ?? 'unsupported'))}</p> : st.status === 'foreign' ? (
        <p className="small warn">{t('perf.dxvk.err.foreignDll')}</p>
      ) : (
        <>
          <Opt note={t('perf.dxvk.note')}>
            <Busy on={busy} />
            {st.admin
              ? <span className={'pill tiny' + (st.status === 'on' ? ' ok-pill' : ' muted')}>{st.status === 'on' ? t('perf.on') : t('perf.off')}</span>
              : <Toggle on={st.status === 'on'} busy={busy} label="DXVK (Vulkan)" onChange={() => toggle(st.status !== 'on')} />}
          </Opt>
          {st.admin && (
            <>
              <p className="dim small">{t('v052.dxvk.adminNote')}</p>
              <Actions>
                <button className="btn ghost sm" disabled={busy} onClick={() => toggle(st.status !== 'on')}><ShieldCheck size={14} /> {st.status === 'on' ? t('v052.dxvk.adminOff') : t('v052.dxvk.admin')}</button>
              </Actions>
            </>
          )}
        </>
      )}
      <Msg text={msg} bad={bad} />
      {ask && (
        <Modal title={t('perf.confirm')} onClose={() => setAsk(null)} actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn" onClick={apply}>{ask.admin ? <><ShieldCheck size={14} /> {t('v052.dxvk.admin')}</> : t('perf.dxvk.write')}</button></>}>
          <p className="small dim">{ask.dir}</p>
          <ul className="small">{ask.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <p className="small dim">{ask.cached ? t('perf.dxvk.cached', { v: ask.version }) : t('perf.dxvk.download', { v: ask.version })}</p>
          {ask.admin && <p className="small dim">{t('v052.dxvk.adminNote')}</p>}
        </Modal>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Benchmark

function Bench({ game, profile }: { game: string; profile?: string }) {
  const t = useT();
  const [st, setSt] = useState<BenchState | null>(null);
  const [mode, setMode] = useState<'map' | 'replay'>('map');
  const [map, setMap] = useState('');
  const [label, setLabel] = useState('baseline');
  const [runs, setRuns] = useState('3');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const s = await invoke<BenchState>('bench_state', { gameId: game });
    setSt(s);
    setMap((m) => m || s.lastMap || '');
  }, [game]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!st) return null;
  const pick = async () => { const p = await invoke<string | null>('bench_pick_map'); if (p) setMap(p); };
  const start = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await invoke<Action>('bench_start', { gameId: game, mode, map: mode === 'map' ? map : null, label, runs: num(runs, 3), profile: profile ?? null });
      setMsg(r.ok ? t('perf.bench.started') : r.message);
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };
  const folder = () => invoke('bench_open_folder', { gameId: game }).catch(() => undefined);
  return (
    <Block title={t('perf.bench.title')}>
      {!st.available && <p className="dim small">{t('perf.bench.needHost')}</p>}
      <Actions>
        <select className="text-in" value={mode} onChange={(e) => setMode(e.target.value as 'map' | 'replay')} disabled={!st.available}>
          <option value="map">{t('perf.bench.map')}</option>
          <option value="replay">{t('perf.bench.replay')}</option>
        </select>
        {mode === 'map' && <button className="btn ghost sm" disabled={!st.available} onClick={pick}>{t('perf.bench.pick')}</button>}
        <input className="text-in" type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} disabled={!st.available} aria-label={t('perf.bench.label')} placeholder={t('perf.bench.label')} />
        <input className="text-in" type="number" min={1} max={10} value={runs} onChange={(e) => setRuns(e.target.value)} disabled={!st.available} style={{ width: 64 }} title={t('perf.bench.runs')} />
        <button className="btn primary sm" disabled={!st.available || busy || (mode === 'map' && !map)} onClick={start} title={t('perf.bench.tip')}>{busy ? <Busy on /> : <Play size={14} />} {t('perf.bench.start')}</button>
      </Actions>
      {mode === 'map' && map && <p className="dim small">{map}</p>}
      <Msg text={msg} />
      {st.available && (
        <Actions>
          <button className="btn ghost sm" onClick={load}>{t('perf.refresh')}</button>
          <button className="btn ghost sm" onClick={folder}><FolderOpen size={14} /> {t('perf.folder')}</button>
        </Actions>
      )}
      {st.results.length > 0 && (
        <table className="table small">
          <thead><tr><th>{t('perf.bench.label')}</th><th>{t('perf.bench.run')}</th><th>FPS</th><th>1 %</th><th>0.1 %</th><th>{t('perf.bench.stutters')}</th></tr></thead>
          <tbody>{st.results.map((r) => <tr key={r.file}><td>{r.label}</td><td>{r.run ?? '-'}</td><td>{f1(r.avgFps)}</td><td>{f1(r.low1Fps)}</td><td>{f1(r.low01Fps)}</td><td>{r.stutters ?? '-'}</td></tr>)}</tbody>
        </table>
      )}
      {st.compare.length > 1 && (
        <table className="table small">
          <thead><tr><th>{t('perf.bench.label')}</th><th>{t('perf.bench.runs')}</th><th>FPS</th><th>1 %</th><th>0.1 %</th></tr></thead>
          <tbody>{st.compare.map((c) => (
            <tr key={c.label}><td>{c.label}</td><td>{c.runs}</td>
              <td>{f1(c.avgFps)} <span className="dim">{pct(c.diffAvg)}</span></td>
              <td>{f1(c.low1Fps)} <span className="dim">{pct(c.diffLow1)}</span></td>
              <td>{f1(c.low01Fps)} <span className="dim">{pct(c.diffLow01)}</span></td></tr>
          ))}</tbody>
        </table>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Replay archive

function Replays({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<ArchState | null>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState('60');
  const [keep, setKeep] = useState('300');
  const [auto, setAuto] = useState(false);
  const [plan, setPlan] = useState<ArchPlan | null>(null);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const s = await invoke<ArchState>('replay_state', { gameId: game });
      setSt(s);
      setDays(String(s.days));
      setKeep(String(s.keep));
      setErr('');
    } catch (e) { setErr(String(e)); }
  }, [game]);
  useEffect(() => { load(); }, [load]);
  const rules = () => ({ days: num(days, 60) || null, keep: num(keep, 300) || null, autosaves: auto });
  const show = async () => {
    setMsg('');
    try { setPlan(await invoke<ArchPlan>('replay_plan', { gameId: game, rules: rules() })); } catch (e) { setMsg(String(e)); }
  };
  const report = (r: Report) => t('perf.rep.moved', { n: r.moved, mb: mb(r.bytes) }) + (r.skipped.length ? ' ' + t('perf.rep.skipped', { n: r.skipped.length }) + ' ' + r.skipped.slice(0, 3).join('; ') : '');
  const run = async () => {
    setPlan(null);
    setBusy(true);
    try { setMsg(report(await invoke<Report>('replay_archive', { gameId: game, rules: rules() }))); await load(); } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };
  const undo = async () => {
    setBusy(true);
    try { setMsg(report(await invoke<Report>('replay_undo', { gameId: game }))); await load(); } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };
  const search = async () => {
    setBusy(true);
    try { setHits(await invoke<Hit[]>('replay_search', { gameId: game, query: q })); } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };
  const restore = async (h: Hit) => {
    try { await invoke('replay_restore', { gameId: game, path: h.path }); setMsg(t('perf.rep.restored')); await load(); await search(); } catch (e) { setMsg(String(e)); }
  };
  const reveal = (p: string) => invoke('reveal_path', { path: p }).catch(() => undefined);
  if (err) return <Block title={t('perf.rep.title')}><p className="dim small">{err}</p></Block>;
  if (!st) return null;
  return (
    <Block title={t('perf.rep.title')}>
      <p className="dim small">{t('perf.rep.count', { n: st.count, mb: mb(st.bytes) })} {t('perf.rep.archived', { n: st.archivedCount, mb: mb(st.archivedBytes) })}</p>
      <div className="perf-fields">
        <label className="small">{t('perf.rep.older')} <input className="text-in" type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 64 }} /> {t('perf.rep.days')}</label>
        <label className="small">{t('perf.rep.keep')} <input className="text-in" type="number" min={0} value={keep} onChange={(e) => setKeep(e.target.value)} style={{ width: 72 }} /></label>
        <label className="check small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t('perf.rep.autosaves')}</label>
      </div>
      <Actions>
        <button className="btn ghost sm" disabled={busy} onClick={show}>{t('perf.rep.archive')}</button>
        <button className="btn ghost sm" disabled={busy || !st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.rep.undo')}</button>
        <button className="btn ghost sm" onClick={() => reveal(st.archiveDir)}><FolderOpen size={14} /> {t('perf.folder')}</button>
      </Actions>
      <Msg text={msg} />
      <Actions>
        <input className="text-in" type="text" value={q} placeholder={t('perf.rep.searchHint')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
        <button className="btn ghost sm" disabled={busy} onClick={search}>{busy ? <Busy on /> : <Search size={14} />} {t('perf.rep.search')}</button>
      </Actions>
      {hits && (hits.length === 0 ? <p className="dim small">{t('perf.rep.none')}</p> : (
        <table className="table small">
          <tbody>{hits.slice(0, 60).map((h) => (
            <tr key={h.path}>
              <td>{h.rel}</td><td>{h.player ?? ''}</td><td>{h.time ?? ''}</td>
              <td>{h.place === 'archive' ? t('perf.rep.inArchive') : ''}</td>
              <td>{h.place === 'archive' && <button className="btn ghost sm" onClick={() => restore(h)}>{t('perf.rep.restore')}</button>} <button className="btn ghost sm" onClick={() => reveal(h.path)}>{t('perf.folder')}</button></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {plan && (
        <Modal title={t('perf.confirm')} onClose={() => setPlan(null)} actions={<><button className="btn ghost" onClick={() => setPlan(null)}>{t('common.cancel')}</button><button className="btn" disabled={plan.count === 0} onClick={run}>{t('perf.rep.archive')}</button></>}>
          <p className="small">{t('perf.rep.plan', { n: plan.count, mb: mb(plan.bytes) })}</p>
          <p className="small dim">{t('perf.rep.target')} {st.archiveDir}</p>
          <ul className="small">{plan.sample.slice(0, 15).map((s) => <li key={s}>{s}</li>)}</ul>
          {plan.count > 15 && <p className="small dim">...</p>}
        </Modal>
      )}
    </Block>
  );
}

// ------------------------------------------------------------------ Record start

function StartWatch({ game }: { game: string }) {
  const t = useT();
  const [st, setSt] = useState<WatchState | null>(null);
  const load = useCallback(async () => { setSt(await invoke<WatchState>('startwatch_state', { gameId: game })); }, [game]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!st?.supported) return null;
  const toggle = async (on: boolean) => { await invoke('startwatch_set', { gameId: game, on }); await load(); };
  return (
    <Block title={t('perf.watch.title')}>
      <Opt label={t('perf.watch.record')} tip={t('perf.watch.tip')}><Toggle on={st.on} label={t('perf.watch.record')} title={t('perf.watch.tip')} onChange={() => toggle(!st.on)} /></Opt>
      {st.rows.length > 0 && (
        <table className="table small">
          <thead><tr><th>{t('perf.watch.time')}</th><th>{t('perf.watch.hung')}</th><th>{t('perf.watch.idle')}</th><th>CPU s</th><th>MB</th><th>{t('perf.watch.files')}</th></tr></thead>
          <tbody>{st.rows.map((r) => (
            <tr key={r.file}><td>{r.started.replace('T', ' ').slice(0, 19)}</td><td>{(r.summary.hungMs / 1000).toFixed(1)}</td><td>{(r.summary.longestIdleMs / 1000).toFixed(1)}</td><td>{(r.summary.cpuMs / 1000).toFixed(1)}</td><td>{r.summary.readMb.toFixed(0)}</td><td>{r.summary.fsEvents}</td></tr>
          ))}</tbody>
        </table>
      )}
      <Actions><button className="btn ghost sm" onClick={() => invoke('startwatch_open_folder')}><FolderOpen size={14} /> {t('perf.folder')}</button></Actions>
    </Block>
  );
}

// ------------------------------------------------------------------ Panel

const GAMES = ['tmnf', 'tmuf', 'tmn-eswc', 'tm-sunrise'];
/** Games with only the Cpu/Gpu synchro (no exe settings, benchmark or archive yet). */
const SYNC_ONLY = ['tm-original'];

export function PerfPanel({ game, profile }: { game: string; profile?: string }) {
  const t = useT();
  const [tab, setTab] = useState<'opt' | 'bench' | 'rep' | 'watch'>('opt');
  if (!isNative || !(GAMES.includes(game) || SYNC_ONLY.includes(game))) return null;
  if (SYNC_ONLY.includes(game)) {
    return (
      <section className="panel">
        <SectionHead title={t('perf.title')} right={<Gauge size={16} />} />
        <GpuSync game={game} />
        <SmoothingHint game={game} profile={profile} />
      </section>
    );
  }
  const tabs: [typeof tab, string][] = [['opt', t('perf.tab.opt')], ['bench', t('perf.tab.bench')], ['rep', t('perf.tab.rep')], ['watch', t('perf.tab.watch')]];
  const body: Record<typeof tab, ReactNode> = {
    opt: <><Optimize game={game} /><GpuSync game={game} /><GameConfig game={game} /><Dxvk game={game} /><SmoothingHint game={game} profile={profile} /></>,
    bench: <Bench game={game} profile={profile} />,
    rep: <Replays game={game} />,
    watch: <StartWatch game={game} />,
  };
  return (
    <section className="panel">
      <SectionHead title={t('perf.title')} right={<Gauge size={16} />} />
      <div className="seg sm perf-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {body[tab]}
    </section>
  );
}
