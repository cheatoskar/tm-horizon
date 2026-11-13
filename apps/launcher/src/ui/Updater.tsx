// TM Horizon self-update (tauri-plugin-updater, src-tauri/src/updater.rs). A check a few seconds after start and
// every six hours while the launcher stays open (quiet when offline). Automatic updates (default): the new
// version downloads in the background and installs at the next start or when the launcher closes (never while a
// game runs); "Restart now" installs at once. Without them: the pill / banner offers Install. A small pill in the
// title bar shows a waiting update; after an update a one-time "What's new" sheet shows the release notes.
// Rules: src/data/updateRules.ts. Only in the native app; the browser preview shows nothing.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RefreshCw, RotateCcw, Download, X, Sparkles, Newspaper } from 'lucide-react';
import { isNative } from '../data/backend';
import { go, useHubState } from '../state';
import { useI18n, useT, tr, fmtDate } from '../i18n';
import { Markdown } from './Markdown';
import { Toggle } from './common';
import { Modal } from './Modal';
import '../styles-updater.css';
import { afterCheck, checkDue, CHECK_EVERY_MS, FIRST_CHECK_MS, showWhatsNew } from '../data/updateRules';

export interface UpdateInfo {
  enabled: boolean; reason: 'no-key' | 'package' | null; current: string; channel: 'stable' | 'beta'; atStart: boolean;
  auto: boolean; staged: string | null;
  available: boolean; version: string | null; notes: string | null; date: string | null;
}
interface Progress { downloaded: number; total: number | null; done: boolean }

const reasonText = (u: UpdateInfo) => (u.reason === 'package' ? tr('upd.offPackage') : tr('upd.offKey'));

// One shared state for the pill, the banner, the sheet and the Settings panel.
interface Outcome { dryRun: boolean; restart: boolean }
type Phase = { kind: 'idle' } | { kind: 'busy'; pct: number | null } | { kind: 'staging'; pct: number | null } | { kind: 'done'; out: Outcome } | { kind: 'error'; msg: string };
interface Store { info: UpdateInfo | null; phase: Phase; sheet: boolean; /** Installing at start: the notice is shown. */ starting: boolean }
let store: Store = { info: null, phase: { kind: 'idle' }, sheet: false, starting: false };
const subs = new Set<() => void>();
function setStore(patch: Partial<Store>) { store = { ...store, ...patch }; subs.forEach((f) => f()); }
function useStore(): Store {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return store;
}

const DISMISS_KEY = 'tmhub.update.dismissed';
const LAST_KEY = 'tmhub.update.lastVersion';
const NOTES_KEY = (v: string) => `tmhub.update.notes.${v}`;
const local = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const dismissedVersion = () => local.get(DISMISS_KEY);

/** Remembers the notes of a version so the "What's new" sheet can show them after the update. */
function keepNotes(u: UpdateInfo) {
  if (u.version && u.notes?.trim()) local.set(NOTES_KEY(u.version), JSON.stringify({ notes: u.notes, date: u.date }));
}

/** Downloads and installs the update found by the last check, now (the Rust side checks the signature). */
async function runInstall(): Promise<void> {
  if (store.phase.kind === 'busy') return;
  setStore({ phase: { kind: 'busy', pct: null } });
  const off = await listen<Progress>('update-progress', (e) => {
    const p = e.payload;
    setStore({ phase: { kind: 'busy', pct: p.done ? 100 : p.total ? Math.round((p.downloaded / p.total) * 100) : null } });
  });
  try {
    if (store.info) keepNotes(store.info);
    const out = await invoke<Outcome>(store.info?.staged && store.info.staged === store.info.version ? 'update_apply' : 'update_install');
    setStore({ phase: { kind: 'done', out } });
  } catch (e) {
    setStore({ phase: { kind: 'error', msg: String(e) } });
  } finally {
    off();
  }
}

/** Background download (automatic updates). Quiet: a failure only shows in the sheet and Settings. */
async function stage(): Promise<void> {
  if (store.phase.kind === 'busy' || store.phase.kind === 'staging') return;
  setStore({ phase: { kind: 'staging', pct: null } });
  const off = await listen<Progress>('update-progress', (e) => {
    const p = e.payload;
    if (store.phase.kind === 'staging') setStore({ phase: { kind: 'staging', pct: p.total ? Math.round((p.downloaded / p.total) * 100) : null } });
  });
  try {
    if (store.info) keepNotes(store.info);
    const info = await invoke<UpdateInfo>('update_stage');
    setStore({ info: { ...info, available: true, version: store.info?.version ?? info.staged, notes: store.info?.notes ?? null, date: store.info?.date ?? null }, phase: { kind: 'idle' } });
  } catch (e) {
    setStore({ phase: { kind: 'error', msg: String(e) } });
  } finally {
    off();
  }
}

const errorText = (msg: string) =>
  /signature|minisign|base64|public key/i.test(msg) ? tr('updb.errSig')
    : /network|request|connect|dns|timed? ?out|error sending|status/i.test(msg) ? tr('updb.errNet')
      : tr('updb.errOther', { msg });

/** The close did not install the downloaded update (a game ran, or the launcher was ended another way): install
 * it now, with a visible notice first. The installer brings the launcher back (Windows: passive NSIS with /R,
 * updater.rs relaunch_after; elsewhere the app restarts itself). */
async function installAtStart() {
  setStore({ sheet: true, starting: true });
  await new Promise((r) => setTimeout(r, 2500));
  await runInstall();
  const ph = store.phase;
  if (ph.kind === 'done' && ph.out.restart) void invoke('update_restart');
  if (ph.kind !== 'done') setStore({ starting: false });
}

/** One check and what follows from it (src/data/updateRules.ts afterCheck). Errors stay quiet. */
async function checkAndAct(atStart: boolean) {
  try {
    const u = await invoke<UpdateInfo>('update_check');
    setStore({ info: u });
    const next = afterCheck(u, atStart);
    if (next === 'stage') await stage();
    else if (next === 'apply') await installAtStart();
  } catch { /* offline or no release yet */ }
}

/** Mounted once next to the app: the check at start (if allowed), then every six hours. */
export function StartupUpdate() {
  useEffect(() => {
    if (!isNative) return;
    let last: number | null = null;
    let live = true;
    const tick = async (atStart: boolean) => {
      if (!live || !checkDue(atStart ? null : last, Date.now())) return;
      try {
        const s = await invoke<UpdateInfo>('update_status');
        // "Check at start" off: no checks at all (an update already downloaded still installs).
        if (!s.enabled || (!s.atStart && !s.staged)) return;
        last = Date.now();
        await checkAndAct(atStart);
      } catch { /* quiet */ }
    };
    const first = setTimeout(() => void tick(true), FIRST_CHECK_MS);
    // Checked every hour whether six hours have passed (a sleeping PC skips timer ticks).
    const every = setInterval(() => void tick(false), Math.min(CHECK_EVERY_MS, 3600_000));
    return () => { live = false; clearTimeout(first); clearInterval(every); };
  }, []);
  return <><UpdateSheet /><WhatsNew /></>;
}

/** Title bar pill: "Update 0.5.2" while one is waiting; a click opens the sheet. */
export function UpdatePill() {
  const { info, phase } = useStore();
  const t = useT();
  if (!isNative || !info?.enabled || !(info.available || info.staged)) return null;
  const v = info.version ?? info.staged ?? '';
  const pct = phase.kind === 'staging' || phase.kind === 'busy' ? phase.pct : null;
  return (
    <button className="upd-pill" onClick={() => setStore({ sheet: true })} title={t('updp.tip')}>
      <Download size={13} /> {t('updp.label', { v })}{pct !== null ? ` · ${pct}%` : ''}
    </button>
  );
}

/** The update sheet: notes, then Install (by hand) or Restart now (downloaded). */
function UpdateSheet() {
  const { info, phase, sheet, starting } = useStore();
  const t = useT();
  if (!sheet || !info) return null;
  if (starting && phase.kind !== 'error') {
    return (
      <Modal title={<><RotateCcw size={16} /> {t('updp.startTitle', { v: info.version ?? info.staged ?? '' })}</>} onClose={() => undefined}>
        <p className="small">{t('updp.startText')}</p>
        <div className="bar"><i style={{ width: `${phase.kind === 'busy' ? (phase.pct ?? 60) : 20}%` }} /></div>
      </Modal>
    );
  }
  const close = () => setStore({ sheet: false });
  const v = info.version ?? info.staged ?? '';
  const ready = !!info.staged && (!info.version || info.staged === info.version);
  const busy = phase.kind === 'busy' || phase.kind === 'staging';
  return (
    <Modal title={<><Download size={16} /> {t('updp.title', { v })}</>} onClose={close} actions={<>
      {phase.kind === 'done' && phase.out.restart && <button className="btn primary" onClick={() => { void invoke('update_restart'); }}><RotateCcw size={14} /> {t('updb.restart')}</button>}
      {phase.kind !== 'done' && (ready
        ? <button className="btn primary" disabled={busy} onClick={() => { void runInstall(); }}><RotateCcw size={14} /> {t('updp.restartNow')}</button>
        : <button className="btn primary" disabled={busy} onClick={() => { void runInstall(); }}><Download size={14} /> {t('updb.install')}</button>)}
      <button className="btn ghost" onClick={close}>{t('updb.later')}</button>
    </>}>
      {info.date && <div className="dim small">{fmtDate(info.date)}</div>}
      {info.notes?.trim() ? <div className="small upd-notes"><Markdown text={info.notes} /></div> : <p className="dim small">{t('updp.noNotes')}</p>}
      <p className="dim small">{ready ? (info.auto ? t('updp.readyAuto') : t('updp.ready')) : info.auto ? t('updp.downloadingAuto') : t('updp.manual')}</p>
      {busy && (
        <div>
          <div className="bar"><i style={{ width: `${phase.pct ?? 5}%` }} /></div>
          <div className="dim small">{t('updb.downloading', { pct: phase.pct === null ? '' : `${phase.pct}%` })}</div>
        </div>
      )}
      {phase.kind === 'error' && <div className="small" style={{ color: '#f87171' }}>{errorText(phase.msg)}</div>}
      {phase.kind === 'done' && <div className="small">{phase.out.dryRun ? t('updb.testDone') : phase.out.restart ? t('upd.restartNote') : t('updb.winNote')}</div>}
    </Modal>
  );
}

/** One-time "What's new in x" after an update: the notes kept when it was downloaded. */
function WhatsNew() {
  const t = useT();
  const [v, setV] = useState<{ version: string; notes: string | null; date: string | null } | null>(null);
  useEffect(() => {
    if (!isNative) return;
    invoke<UpdateInfo>('update_status').then((s) => {
      const last = local.get(LAST_KEY);
      local.set(LAST_KEY, s.current);
      if (!showWhatsNew(last, s.current)) return;
      let kept: { notes?: string; date?: string | null } = {};
      try { kept = JSON.parse(local.get(NOTES_KEY(s.current)) ?? '{}'); } catch { /* none */ }
      setV({ version: s.current, notes: kept.notes ?? null, date: kept.date ?? null });
    }).catch(() => {});
  }, []);
  if (!v) return null;
  const close = () => setV(null);
  return (
    <Modal title={<><Sparkles size={16} /> {t('updw.title', { v: v.version })}</>} onClose={close} actions={<>
      <button className="btn ghost" onClick={() => { close(); go('news'); }}><Newspaper size={14} /> {t('updw.news')}</button>
      <button className="btn primary" onClick={close}>{t('common.close')}</button>
    </>}>
      {v.notes ? <div className="small upd-notes"><Markdown text={v.notes} /></div> : <p className="dim small">{t('updw.noNotes')}</p>}
    </Modal>
  );
}

/** "Update available" banner at the top of the main area: only without automatic updates (they use the pill). */
export function UpdateBanner() {
  const { info, phase } = useStore();
  const t = useT();
  const [hiddenFor, setHiddenFor] = useState<string | null>(() => dismissedVersion());
  const [more, setMore] = useState(false);
  if (!isNative || !info?.enabled || !info.available || !info.version || info.auto) return null;
  if (hiddenFor === info.version && phase.kind === 'idle') return null;
  const later = () => {
    local.set(DISMISS_KEY, info.version!);
    setHiddenFor(info.version);
  };
  const date = info.date ? fmtDate(info.date) : '';
  const busy = phase.kind === 'busy';
  return (
    <div className="revoked-banner" role="status" style={{ borderColor: 'rgba(var(--tint), 0.25)', background: 'rgba(var(--tint), 0.06)' }}>
      <Download size={18} style={{ flex: 'none', marginTop: 2 }} />
      <div className="grow">
        <b>{t('updb.title')}</b>
        <div className="dim small">{t('updb.version', { v: info.version })}{date ? ` · ${date}` : ''}</div>
        {info.notes?.trim() && (
          <div style={{ marginTop: 6 }}>
            <div className="small" style={more ? undefined : { maxHeight: '6em', overflow: 'hidden' }}><Markdown text={info.notes} /></div>
            <button className="btn ghost sm" onClick={() => setMore(!more)}>{more ? t('updb.less') : t('updb.more')}</button>
          </div>
        )}
        {busy && (
          <div style={{ marginTop: 8 }}>
            <div className="bar"><i style={{ width: `${phase.pct ?? 5}%` }} /></div>
            <div className="dim small">{t('updb.downloading', { pct: phase.pct === null ? '' : `${phase.pct}%` })}</div>
          </div>
        )}
        {phase.kind === 'error' && <div className="small" style={{ marginTop: 6, color: '#f87171' }}>{errorText(phase.msg)}</div>}
        {phase.kind === 'done' && (
          <div className="small" style={{ marginTop: 6 }}>
            {phase.out.dryRun ? t('updb.testDone') : phase.out.restart ? t('upd.restartNote') : t('updb.winNote')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
        {phase.kind === 'done' && phase.out.restart && <button className="btn primary sm" onClick={() => { void invoke('update_restart'); }}><RotateCcw size={14} /> {t('updb.restart')}</button>}
        {phase.kind !== 'done' && <button className="btn primary sm" disabled={busy} onClick={() => { void runInstall(); }}>{t('updb.install')}</button>}
        {phase.kind !== 'done' && <button className="btn ghost sm" disabled={busy} onClick={later}>{t('updb.later')}</button>}
        {phase.kind === 'done' && <button className="btn ghost sm" onClick={later}><X size={14} /></button>}
      </div>
    </div>
  );
}

/** Settings: channel, check at start, automatic updates, check now, install. */
export function UpdatePanel() {
  const hub = useHubState();
  const { t } = useI18n();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { phase } = useStore();

  useEffect(() => { if (isNative) invoke<UpdateInfo>('update_status').then(setInfo).catch(() => {}); }, []);
  if (!isNative || !info) return null;

  const save = async (channel: string, atStart: boolean, auto: boolean) => {
    try {
      const u = await invoke<UpdateInfo>('update_settings', { channel, atStart, auto });
      setInfo(u); setStatus(null);
      if (store.info) setStore({ info: { ...store.info, auto: u.auto, staged: u.staged } });
    } catch (e) { hub.toast({ message: String(e), ok: false }); }
  };
  const check = async () => {
    setBusy(true); setStatus(t('upd.checking'));
    try {
      await checkAndAct(false);
      const u = store.info ?? await invoke<UpdateInfo>('update_status');
      setInfo(u);
      setStatus(!u.enabled ? reasonText(u) : u.available ? t('upd.available', { v: u.version ?? '' }) : t('upd.none', { v: u.current }));
    } catch (e) { setStatus(String(e)); }
    setBusy(false);
  };
  const doInstall = async () => {
    await runInstall();
    if (store.phase.kind === 'done' && store.phase.out.restart) {
      hub.toast({ message: tr('upd.restartNote'), sticky: true, actions: [{ label: tr('upd.restart'), primary: true, run: () => { void invoke('update_restart'); } }] });
    }
  };
  const working = busy || phase.kind === 'busy' || phase.kind === 'staging';
  const line = phase.kind === 'busy' || phase.kind === 'staging' ? t('upd.installing', { pct: phase.pct === null ? '' : `${phase.pct}%` })
    : phase.kind === 'error' ? errorText(phase.msg)
      : phase.kind === 'done' ? (phase.out.dryRun ? t('updb.testDone') : phase.out.restart ? t('upd.restartNote') : t('updb.winNote'))
        : info.staged ? t('updp.readyShort', { v: info.staged })
          : status ?? t('upd.current', { v: info.current });

  return (
    <section className="panel">
      <div className="setrow">
        <RefreshCw size={18} />
        <div className="grow"><b>{t('upd.title')}</b><div className="dim small setnote">{info.enabled ? t('upd.channelNote') : reasonText(info)}</div></div>
        <select className="text-in" value={info.channel} aria-label={t('upd.channel')} onChange={(e) => save(e.target.value, info.atStart, info.auto)}>
          <option value="stable">{t('upd.stable')}</option>
          <option value="beta">{t('upd.beta')}</option>
        </select>
      </div>
      <div className="setrow">
        <div className="grow"><b>{t('upd.atStart')}</b></div>
        <Toggle on={info.atStart} label={t('upd.atStart')} onChange={() => save(info.channel, !info.atStart, info.auto)} />
      </div>
      <div className="setrow">
        <div className="grow"><b>{t('upd.auto')}</b><div className="dim small setnote">{t('upd.autoNote')}</div></div>
        <Toggle on={info.auto} label={t('upd.auto')} onChange={() => save(info.channel, info.atStart, !info.auto)} />
      </div>
      <div className="setrow">
        <div className="grow dim small">{line}</div>
        {info.staged
          ? <button className="btn primary sm" disabled={working} onClick={() => setStore({ sheet: true })}><RotateCcw size={14} /> {t('updp.restartNow')}</button>
          : info.available && info.enabled
            ? <button className="btn primary sm" disabled={working} onClick={doInstall}><Download size={14} /> {t('upd.install')}</button>
            : <button className="btn ghost sm" disabled={working || !info.enabled} onClick={check}><RotateCcw size={14} /> {t('upd.check')}</button>}
      </div>
    </section>
  );
}
