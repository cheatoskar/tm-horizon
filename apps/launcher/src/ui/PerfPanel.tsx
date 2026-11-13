// Performance panel of a game page: Windows per-exe settings and the game's graphics config, the
// benchmark hand-over to Horizon Host, the replay archive and "Record start".
// Rust side: optimize.rs, syscfg.rs, perfbench.rs, replayarchive.rs, startwatch.rs. Docs: docs/optimize.md.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Gauge, Loader2, Play, RotateCcw, Search } from 'lucide-react';
import { isNative } from '../data/backend';
import { tr, useT } from '../i18n';
import { Modal } from './Modal';
import { SectionHead } from './common';

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
  return (
    <div className="stack">
      <h3 className="small">{t('perf.win.title')}</h3>
      {!st.supported ? <p className="dim small">{st.reason}</p> : (
        <>
          <label className="check small" title={t('perf.fso.tip')}><input type="checkbox" checked={want.fso} onChange={(e) => setWant({ ...want, fso: e.target.checked })} /> {t('perf.fso')}</label>
          <label className="check small" title={t('perf.dpi.tip')}><input type="checkbox" checked={want.dpi} onChange={(e) => setWant({ ...want, dpi: e.target.checked })} /> {t('perf.dpi')}</label>
          <label className="check small" title={t('perf.gpu.tip')}><input type="checkbox" checked={want.gpu} onChange={(e) => setWant({ ...want, gpu: e.target.checked })} /> {t('perf.gpu')}</label>
          <div className="setrow">
            <button className="btn ghost sm" disabled={!dirty} onClick={plan}>{t('perf.apply')}</button>
            <button className="btn ghost sm" disabled={!st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.undo')}</button>
          </div>
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
    </div>
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
  if (err) return <div className="stack"><h3 className="small">{t('perf.cfg.title')}</h3><p className="dim small">{err}</p></div>;
  if (!st || !edit) return null;
  const d = st.display;
  const tex = ['perf.tex.0', 'perf.tex.1', 'perf.tex.2', 'perf.tex.3'];
  const sh = ['perf.sh.0', 'perf.sh.1', 'perf.sh.2', 'perf.sh.3', 'perf.sh.4', 'perf.sh.5'];
  const dirty = edit.fullscreen !== d.fullscreen || edit.vsync !== d.vsync || edit.antialiasing !== d.antialiasing;
  return (
    <div className="stack">
      <h3 className="small">{t('perf.cfg.title')} {st.writable && <span className="pill tiny muted" title={t('perf.cfg.untested')}>{t('perf.badge.experimental')}</span>}</h3>
      <p className="dim small">
        {d.width} x {d.height}, {d.fullscreen ? t('perf.cfg.full') : t('perf.cfg.window')}, V-Sync {d.vsync ? t('perf.on') : t('perf.off')}, {t('perf.cfg.aa')}: {aaLabel(AA[d.antialiasing] ?? String(d.antialiasing))}
        {d.textures != null && <>, {t('perf.cfg.textures')}: {t(tex[d.textures] ?? 'perf.tex.0')}</>}
        {d.shadows != null && <>, {t('perf.cfg.shadows')}: {t(sh[d.shadows] ?? 'perf.sh.0')}</>}
      </p>
      {st.tips.map((x) => <p key={x} className="small">{t('perf.tip.' + x)}</p>)}
      {st.writable ? (
        <>
          <div className="setrow">
            <label className="check small"><input type="checkbox" checked={edit.fullscreen} onChange={(e) => setEdit({ ...edit, fullscreen: e.target.checked })} /> {t('perf.cfg.fullscreen')}</label>
            <label className="check small"><input type="checkbox" checked={edit.vsync} onChange={(e) => setEdit({ ...edit, vsync: e.target.checked })} /> V-Sync</label>
            <label className="small nowrap">{t('perf.cfg.aa')} <select value={edit.antialiasing} onChange={(e) => setEdit({ ...edit, antialiasing: Number(e.target.value) })}>{AA.map((a, i) => <option key={a} value={i}>{aaLabel(a)}</option>)}</select></label>
          </div>
          <div className="setrow">
            <button className="btn ghost sm" disabled={!dirty} onClick={plan}>{t('perf.apply')}</button>
            <button className="btn ghost sm" disabled={!st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.undo')}</button>
          </div>
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
    </div>
  );
}

// ------------------------------------------------------------------ DXVK

interface DxState { supported: boolean; reason: string | null; dir: string | null; status: 'on' | 'off' | 'foreign'; version: string }
interface DxPlan { dir: string; files: string[]; conf: string; version: string; cached: boolean }
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
        const r = await invoke<DxReport>('dxvk_off', { gameId: game });
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
    setAsk(null);
    setBusy(true);
    try { await invoke('dxvk_on', { gameId: game }); setBad(false); setMsg(t('perf.dxvk.written')); await load(); } catch (e) { fail(e); }
    setBusy(false);
  };
  if (!st) return null;
  return (
    <div className="stack">
      <h3 className="small">{t('perf.dxvk.title')} <span className="pill tiny muted" title={t('perf.dxvk.untested')}>{t('perf.badge.experimental')}</span></h3>
      {!st.supported ? <p className="dim small">{t('perf.dxvk.err.' + (st.reason ?? 'unsupported'))}</p> : (
        <>
          <div className="setrow">
            <label className="check small nowrap" title={t('perf.dxvk.note')}><input type="checkbox" checked={st.status === 'on'} disabled={busy || (st.status === 'foreign')} onChange={(e) => toggle(e.target.checked)} /> DXVK (Vulkan)</label>
            <Busy on={busy} />
          </div>
          {st.status === 'foreign' && <p className="dim small">{t('perf.dxvk.err.foreignDll')}</p>}
        </>
      )}
      <Msg text={msg} bad={bad} />
      {ask && (
        <Modal title={t('perf.confirm')} onClose={() => setAsk(null)} actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn" onClick={apply}>{t('perf.dxvk.write')}</button></>}>
          <p className="small dim">{ask.dir}</p>
          <ul className="small">{ask.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <p className="small dim">{ask.cached ? t('perf.dxvk.cached', { v: ask.version }) : t('perf.dxvk.download', { v: ask.version })}</p>
        </Modal>
      )}
    </div>
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
    <div className="stack">
      <h3 className="small">{t('perf.bench.title')}</h3>
      {!st.available && <p className="dim small">{t('perf.bench.needHost')}</p>}
      <div className="setrow">
        <select value={mode} onChange={(e) => setMode(e.target.value as 'map' | 'replay')} disabled={!st.available}>
          <option value="map">{t('perf.bench.map')}</option>
          <option value="replay">{t('perf.bench.replay')}</option>
        </select>
        {mode === 'map' && <button className="btn ghost sm" disabled={!st.available} onClick={pick}>{t('perf.bench.pick')}</button>}
        <input type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} disabled={!st.available} aria-label={t('perf.bench.label')} placeholder={t('perf.bench.label')} />
        <input type="number" min={1} max={10} value={runs} onChange={(e) => setRuns(e.target.value)} disabled={!st.available} style={{ width: 64 }} title={t('perf.bench.runs')} />
        <button className="btn sm" disabled={!st.available || busy || (mode === 'map' && !map)} onClick={start} title={t('perf.bench.tip')}>{busy ? <Busy on /> : <Play size={14} />} {t('perf.bench.start')}</button>
      </div>
      {mode === 'map' && map && <p className="dim small">{map}</p>}
      <Msg text={msg} />
      {st.available && (
        <div className="setrow">
          <button className="btn ghost sm" onClick={load}>{t('perf.refresh')}</button>
          <button className="btn ghost sm" onClick={folder}><FolderOpen size={14} /> {t('perf.folder')}</button>
        </div>
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
    </div>
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
  if (err) return <div className="stack"><h3 className="small">{t('perf.rep.title')}</h3><p className="dim small">{err}</p></div>;
  if (!st) return null;
  return (
    <div className="stack">
      <h3 className="small">{t('perf.rep.title')}</h3>
      <p className="dim small">{t('perf.rep.count', { n: st.count, mb: mb(st.bytes) })} {t('perf.rep.archived', { n: st.archivedCount, mb: mb(st.archivedBytes) })}</p>
      <div className="setrow">
        <label className="small">{t('perf.rep.older')} <input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 64 }} /> {t('perf.rep.days')}</label>
        <label className="small">{t('perf.rep.keep')} <input type="number" min={0} value={keep} onChange={(e) => setKeep(e.target.value)} style={{ width: 72 }} /></label>
        <label className="check small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t('perf.rep.autosaves')}</label>
      </div>
      <div className="setrow">
        <button className="btn ghost sm" disabled={busy} onClick={show}>{t('perf.rep.archive')}</button>
        <button className="btn ghost sm" disabled={busy || !st.canUndo} onClick={undo}><RotateCcw size={14} /> {t('perf.rep.undo')}</button>
        <button className="btn ghost sm" onClick={() => reveal(st.archiveDir)}><FolderOpen size={14} /> {t('perf.folder')}</button>
      </div>
      <Msg text={msg} />
      <div className="setrow">
        <input type="text" value={q} placeholder={t('perf.rep.searchHint')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
        <button className="btn ghost sm" disabled={busy} onClick={search}>{busy ? <Busy on /> : <Search size={14} />} {t('perf.rep.search')}</button>
      </div>
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
    </div>
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
    <div className="stack">
      <h3 className="small">{t('perf.watch.title')}</h3>
      <label className="check small" title={t('perf.watch.tip')}><input type="checkbox" checked={st.on} onChange={(e) => toggle(e.target.checked)} /> {t('perf.watch.record')}</label>
      {st.rows.length > 0 && (
        <table className="table small">
          <thead><tr><th>{t('perf.watch.time')}</th><th>{t('perf.watch.hung')}</th><th>{t('perf.watch.idle')}</th><th>CPU s</th><th>MB</th><th>{t('perf.watch.files')}</th></tr></thead>
          <tbody>{st.rows.map((r) => (
            <tr key={r.file}><td>{r.started.replace('T', ' ').slice(0, 19)}</td><td>{(r.summary.hungMs / 1000).toFixed(1)}</td><td>{(r.summary.longestIdleMs / 1000).toFixed(1)}</td><td>{(r.summary.cpuMs / 1000).toFixed(1)}</td><td>{r.summary.readMb.toFixed(0)}</td><td>{r.summary.fsEvents}</td></tr>
          ))}</tbody>
        </table>
      )}
      <div className="setrow"><button className="btn ghost sm" onClick={() => invoke('startwatch_open_folder')}><FolderOpen size={14} /> {t('perf.folder')}</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Panel

const GAMES = ['tmnf', 'tmuf', 'tmn-eswc', 'tm-sunrise'];

export function PerfPanel({ game, profile }: { game: string; profile?: string }) {
  const t = useT();
  const [tab, setTab] = useState<'opt' | 'bench' | 'rep' | 'watch'>('opt');
  if (!isNative || !GAMES.includes(game)) return null;
  const tabs: [typeof tab, string][] = [['opt', t('perf.tab.opt')], ['bench', t('perf.tab.bench')], ['rep', t('perf.tab.rep')], ['watch', t('perf.tab.watch')]];
  const body: Record<typeof tab, ReactNode> = {
    opt: <><Optimize game={game} /><GameConfig game={game} /><Dxvk game={game} /></>,
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
