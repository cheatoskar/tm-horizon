// "Install the game on Linux": a card for the game page and a section in Settings > Linux, plus the
// dialog that sets up Wine/umu-run + Proton, a prefix, DXVK, the game and TMLoader. Backend:
// src-tauri (linux_setup_* commands and linux-setup-* events); this file only shows and starts it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Check, FolderPlus, Loader2, Minus, X, Wrench, ScrollText, Download, ExternalLink, Copy } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { useHubState } from '../state';
import { useI18n, useT } from '../i18n';
import { Modal } from './Modal';
import { LINUX_SETUP_EVENT } from './linuxOpen';

interface InstallCmd { label: string; command: string; matches: boolean }
interface ToolInfo { path: string; name: string; own: boolean }
interface Runners { wine: { path: string; version: string; staging: boolean } | null; umu: ToolInfo | null; protons: ToolInfo[]; winetricks: string | null; python3: boolean; taskset: boolean; distro: string; commands: InstallCmd[] }
interface PrefixOptions { dxvk: boolean; sync: boolean; cpuLimit: number; virtualDesktop: string | null; grabMouse: boolean; pulseAudio: boolean; windowsVersion: 'win10' | 'win7' | 'winxp'; dxvkVersion: string | null }
interface SetupStatus { platform: string; game: string; kind: 'download' | 'existing' | 'steam' | ''; prefix: string; prefixExists: boolean; installed: string | null; tmloader: boolean; options: PrefixOptions; running: string | null; steps: { step: string; state: 'wait' | 'run' | 'ok' | 'skip' | 'fail'; note: string }[]; runners: Runners }
interface SetupPlan { game: string; runner: 'wine' | 'umu'; getUmu: boolean; getProton: boolean; proton: string | null; winetricks: string[]; installGame: boolean; tmloader: boolean; options: PrefixOptions; repair: boolean }
interface StepEvt { game: string; step: string; state: 'run' | 'ok' | 'skip' | 'fail'; note: string }
interface ProgEvt { game: string; step: string; received: number; total: number | null }
interface DoneEvt { game: string; ok: boolean; cancelled: boolean; error: string | null }

type Mode = 'install' | 'repair' | 'fixes' | 'log';
type StepState = 'pending' | 'run' | 'ok' | 'skip' | 'fail';

const ALL_STEPS = ['runner', 'prefix', 'dxvk', 'winetricks', 'game', 'tmloader', 'register'];
const STEAM_IDS: Record<string, number> = { maniaplanet: 228760, 'sm-storm': 228760, tm2020: 2225070, 'tm-turbo': 375900 };
const steamId = (game: string) => (game.startsWith('tm2-') ? 228760 : STEAM_IDS[game]);
const MAX_LINES = 500;

/** Status of one game's Linux setup; null off Linux or outside the app. Refreshes when a setup ends. */
function useSetupStatus(game: string) {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const reload = useCallback(() => {
    if (!isNative) return;
    invoke<SetupStatus>('linux_setup_status', { game }).then(setSt).catch(() => setSt(null));
  }, [game]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!isNative) return;
    let off: UnlistenFn | undefined;
    let dead = false;
    listen<DoneEvt>('linux-setup-done', (e) => { if (e.payload.game === game) reload(); }).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, [game, reload]);
  return { st: st && st.platform === 'linux' ? st : null, reload };
}

function CopyCmd({ c }: { c: InstallCmd }) {
  const { t } = useI18n();
  const hub = useHubState();
  return (
    <div className="lsetup-cmd">
      <div className="dim small">{c.label}</div>
      <div className="row-btns">
        <code className="mono grow lsetup-code">{c.command}</code>
        <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(c.command).then(() => hub.toast({ message: t('lsetup.copied') })).catch(() => undefined)}><Copy size={14} /> {t('common.copy')}</button>
      </div>
    </div>
  );
}

function InstallCommands({ cmds }: { cmds: InstallCmd[] }) {
  const t = useT();
  const first = cmds.find((c) => c.matches) ?? cmds[0];
  const rest = cmds.filter((c) => c !== first);
  if (!first) return null;
  return (
    <div>
      <CopyCmd c={first} />
      {rest.length > 0 && (
        <details className="lsetup-other">
          <summary className="dim small">{t('lsetup.otherSystems')}</summary>
          {rest.map((c) => <CopyCmd key={c.label} c={c} />)}
        </details>
      )}
    </div>
  );
}

function Check1({ checked, onChange, disabled, label, note }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; note?: string }) {
  return (
    <label className={'lsetup-opt' + (disabled ? ' off' : '')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b>{note && <span className="dim small lsetup-note">{note}</span>}</span>
    </label>
  );
}

function FixesBlock({ o, set, runner, r, showHead }: { o: PrefixOptions; set: (p: Partial<PrefixOptions>) => void; runner: 'wine' | 'umu' | null; r: Runners; showHead: boolean }) {
  const t = useT();
  const noTaskset = runner !== 'umu' && !r.taskset;
  return (
    <div className="lsetup-block">
      {showHead && <b>{t('lsetup.fixesHead')}</b>}
      <Check1 checked={o.dxvk} onChange={(v) => set({ dxvk: v })} label="DXVK"
        note={o.dxvkVersion ? t('lsetup.dxvkInstalled', { version: o.dxvkVersion }) + ' · ' + t('lsetup.dxvkNote') : t('lsetup.dxvkNote') + (runner === 'wine' ? ' ' + t('lsetup.dxvkWine') : '')} />
      <Check1 checked={o.sync} onChange={(v) => set({ sync: v })} label={t('lsetup.sync')} note={t('lsetup.syncNote')} />
      <Check1 checked={o.grabMouse} onChange={(v) => set({ grabMouse: v })} label={t('lsetup.grab')} note={t('lsetup.grabNote')} />
      <Check1 checked={o.pulseAudio} onChange={(v) => set({ pulseAudio: v })} label={t('lsetup.pulse')} note={t('lsetup.pulseNote')} />
      <Check1 checked={o.cpuLimit > 0} onChange={(v) => set({ cpuLimit: v ? 4 : 0 })} disabled={noTaskset} label={t('lsetup.cpu')} note={noTaskset ? t('lsetup.needsTaskset') : t('lsetup.cpuNote')} />
      <Check1 checked={o.virtualDesktop !== null} onChange={(v) => set({ virtualDesktop: v ? '1920x1080' : null })} disabled={runner === 'umu'} label={t('lsetup.vdesk')} note={t('lsetup.vdeskNote')} />
      {o.virtualDesktop !== null && runner !== 'umu' && (
        <input className="text-in mono lsetup-vd" value={o.virtualDesktop} placeholder="1920x1080" aria-label={t('lsetup.vdesk')} onChange={(e) => set({ virtualDesktop: e.target.value.trim() })} />
      )}
      <div className="setrow lsetup-ver">
        <div className="grow"><b>{t('lsetup.winver')}</b></div>
        <select className="text-in" value={o.windowsVersion} aria-label={t('lsetup.winver')} onChange={(e) => set({ windowsVersion: e.target.value as PrefixOptions['windowsVersion'] })}>
          <option value="win10">Windows 10</option>
          <option value="win7">Windows 7</option>
          <option value="winxp">Windows XP</option>
        </select>
      </div>
      <p className="dim small">{t('lsetup.crashNote')}</p>
    </div>
  );
}

function StepIcon({ s }: { s: StepState }) {
  if (s === 'run') return <Loader2 size={15} className="spin" />;
  if (s === 'ok') return <Check size={15} />;
  if (s === 'skip') return <Minus size={15} />;
  if (s === 'fail') return <X size={15} />;
  return <span className="lsetup-dot" />;
}

function LinuxSetupDialog({ game, st, mode, shown, onHide, onGone, reload }: { game: string; st: SetupStatus; mode: Mode; shown: boolean; onHide: () => void; onGone: () => void; reload: () => void }) {
  const { t } = useI18n();
  const hub = useHubState();
  const r = st.runners;
  const name = hub.game(game)?.name ?? game;
  const [view, setView] = useState<'config' | 'progress' | 'log'>(mode === 'log' ? 'log' : st.running === game ? 'progress' : 'config');
  const [runner, setRunner] = useState<'wine' | 'umu'>(r.wine ? 'wine' : 'umu');
  const [getUmu, setGetUmu] = useState(!r.umu && r.python3);
  const [getProton, setGetProton] = useState(r.protons.length === 0);
  const [proton, setProton] = useState<string | null>(r.protons[0]?.path ?? null);
  const [opts, setOpts] = useState<PrefixOptions>(st.options);
  const [verbs, setVerbs] = useState<string[]>([]);
  const [installGame, setInstallGame] = useState(true);
  const [tmloader, setTmloader] = useState(true);
  const [busy, setBusy] = useState(false);
  // Reopened during (or after) a setup: the backend remembers the steps and their state.
  const [steps, setSteps] = useState<string[]>(st.steps.length ? st.steps.map((s) => s.step) : ALL_STEPS);
  const [state, setState] = useState<Record<string, { state: StepState; note: string }>>(() => Object.fromEntries(st.steps.filter((s) => s.state !== 'wait').map((s) => [s.step, { state: s.state as StepState, note: s.note }])));
  const [prog, setProg] = useState<ProgEvt | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(st.running === game);
  const [result, setResult] = useState<DoneEvt | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const pushLines = useCallback((add: string[]) => setLines((l) => [...l, ...add].slice(-MAX_LINES)), []);

  // Events of this game's setup. They keep coming while the dialog is hidden.
  useEffect(() => {
    const offs: UnlistenFn[] = [];
    let dead = false;
    const on = <T extends { game: string }>(ev: string, fn: (p: T) => void) =>
      listen<T>(ev, (e) => { if (e.payload.game === game) fn(e.payload); }).then((f) => { if (dead) f(); else offs.push(f); });
    on<StepEvt>('linux-setup-step', (p) => setState((s) => ({ ...s, [p.step]: { state: p.state, note: p.note } })));
    on<{ game: string; line: string }>('linux-setup-log', (p) => pushLines([p.line]));
    on<ProgEvt>('linux-setup-progress', (p) => setProg(p));
    on<DoneEvt>('linux-setup-done', (p) => {
      setRunning(false);
      setProg(null);
      setResult(p);
      void backend.rescan().catch(() => undefined);
      reload();
      hub.toast(p.ok ? { ok: true, message: t('lsetup.done', { game: name }) } : p.cancelled ? { message: t('lsetup.cancelled') } : { ok: false, message: p.error ? `${t('lsetup.failed')}: ${p.error}` : t('lsetup.failed') });
      if (!shownRef.current) onGone();
    });
    return () => { dead = true; offs.forEach((f) => f()); };
  }, [game]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fill the log when the dialog opens during or after a setup.
  useEffect(() => {
    if (mode === 'log' || st.running === game) invoke<string>('linux_setup_log', { game }).then((s) => setLines((l) => (l.length ? l : s.split('\n').filter(Boolean).slice(-MAX_LINES)))).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, view, shown]);

  const set = (p: Partial<PrefixOptions>) => setOpts((o) => ({ ...o, ...p }));
  const close = () => { if (running) onHide(); else onGone(); };
  const repair = mode === 'repair';

  const start = async () => {
    const plan: SetupPlan = {
      game, runner, getUmu: runner === 'umu' && getUmu, getProton: runner === 'umu' && getProton, proton: runner === 'umu' && !getProton ? proton : null,
      winetricks: repair ? [] : verbs, installGame: repair ? false : installGame, tmloader: repair ? false : tmloader, options: opts, repair,
    };
    setBusy(true);
    try {
      const ids = await invoke<string[]>('linux_setup_start', { plan });
      setSteps(ids);
      setState({});
      setLines([]);
      setResult(null);
      setProg(null);
      setRunning(true);
      setView('progress');
      reload();
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  const saveFixes = async () => {
    setBusy(true);
    try {
      await invoke<PrefixOptions>('linux_setup_options', { game, options: opts });
      hub.toast({ message: t('lsetup.saved') });
      reload();
      onGone();
    } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  const cancel = () => { invoke('linux_setup_cancel').catch((e) => hub.toast({ ok: false, message: String(e) })); };

  if (!shown) return null;

  const noRunner = !r.wine && !r.umu;
  const title = mode === 'fixes' ? t('lsetup.dlgFixes', { game: name }) : mode === 'log' ? t('lsetup.log') : repair ? t('lsetup.dlgRepair', { game: name }) : t('lsetup.dlgInstall', { game: name });
  const mb = (n: number) => (n / 1048576).toFixed(1);

  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (view === 'progress' || view === 'log') {
    const log = <pre ref={logRef} className="lsetup-log mono">{lines.length ? lines.join('\n') : t('lsetup.logEmpty')}</pre>;
    if (view === 'log') {
      body = log;
      actions = <button className="btn primary" onClick={close}>{t('common.close')}</button>;
    } else {
      body = (
        <>
          <ul className="lsetup-steps">
            {steps.map((id) => {
              const s = state[id] ?? { state: 'pending' as StepState, note: '' };
              return (
                <li key={id} className={'lsetup-step ' + s.state}>
                  <StepIcon s={s.state} />
                  <div className="grow">
                    <div>{t(`lsetup.step.${id}`)}</div>
                    {s.note && <div className="dim small">{s.note}</div>}
                    {s.state === 'run' && prog && prog.step === id && (
                      <div className="lsetup-bar-wrap">
                        <div className="lsetup-bar"><div style={{ width: prog.total ? `${Math.min(100, (prog.received / prog.total) * 100)}%` : '30%' }} className={prog.total ? '' : 'indet'} /></div>
                        <span className="dim small">{prog.total ? t('lsetup.mb', { a: mb(prog.received), b: mb(prog.total) }) : t('lsetup.mbOnly', { a: mb(prog.received) })}</span>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {result && !result.ok && !result.cancelled && result.error && <p className="small warn">{result.error}</p>}
          {log}
        </>
      );
      actions = running
        ? <button className="btn ghost" onClick={cancel}>{t('common.cancel')}</button>
        : <>
            {result && !result.ok && !result.cancelled && <button className="btn ghost" onClick={() => setView('config')}>{t('common.retry')}</button>}
            <button className="btn primary" onClick={close}>{t('common.close')}</button>
          </>;
    }
  } else {
    const fixesOnly = mode === 'fixes';
    body = (
      <>
        {!fixesOnly && (
          <div className="lsetup-block">
            <b>{t('lsetup.runnerHead')}</b>
            <ul className="lsetup-found small">
              {r.wine && <li>{t('lsetup.wineFound', { version: r.wine.version })}{r.wine.staging ? ` (${t('lsetup.staging')})` : ''}</li>}
              {r.umu && <li>{t('lsetup.umuFound', { name: r.umu.name })}{r.umu.own ? ` · ${t('lsetup.downloaded')}` : ''}</li>}
              {r.protons.map((p) => <li key={p.path}>{p.name}{p.own ? ` · ${t('lsetup.downloaded')}` : ''}</li>)}
            </ul>
            {noRunner && (
              <>
                <p className="small">{t('lsetup.noRunner')}</p>
                <InstallCommands cmds={r.commands} />
                <p className="dim small">{t('lsetup.noRoot')}</p>
              </>
            )}
            <div className="lsetup-radios">
              <label className={'lsetup-opt' + (!r.wine ? ' off' : '')}><input type="radio" name="lsetup-runner" checked={runner === 'wine'} disabled={!r.wine} onChange={() => setRunner('wine')} /><span><b>{t('lsetup.runnerWine')}</b></span></label>
              <label className="lsetup-opt"><input type="radio" name="lsetup-runner" checked={runner === 'umu'} onChange={() => setRunner('umu')} /><span><b>{t('lsetup.runnerUmu')}</b></span></label>
            </div>
            {runner === 'umu' && (
              <>
                <Check1 checked={getUmu} onChange={setGetUmu} disabled={!r.python3} label={t('lsetup.getUmu')} note={!r.python3 ? t('lsetup.needsPython') : undefined} />
                <Check1 checked={getProton} onChange={setGetProton} label={t('lsetup.getProton')} />
                {r.protons.length > 0 && !getProton && (
                  <div className="setrow">
                    <div className="grow"><b>{t('lsetup.protonPick')}</b></div>
                    <select className="text-in" value={proton ?? ''} aria-label={t('lsetup.protonPick')} onChange={(e) => setProton(e.target.value || null)}>
                      {r.protons.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <FixesBlock o={opts} set={set} runner={fixesOnly ? null : runner} r={r} showHead={!fixesOnly} />
        {mode === 'install' && (
          <>
            <div className="lsetup-block">
              <b>{t('lsetup.extrasHead')}</b>
              {(['corefonts', 'd3dx9'] as const).map((v) => {
                const off = runner === 'wine' && !r.winetricks;
                return <Check1 key={v} checked={verbs.includes(v)} disabled={off} onChange={(on) => setVerbs((x) => (on ? [...x, v] : x.filter((y) => y !== v)))} label={t(`lsetup.${v}`)} note={off ? t('lsetup.needsWinetricks') : undefined} />;
              })}
              <p className="dim small">{t('lsetup.extrasNote')}</p>
            </div>
            <div className="lsetup-block">
              <Check1 checked={installGame} onChange={setInstallGame} label={t('lsetup.installGame')} />
              <Check1 checked={tmloader} onChange={setTmloader} label={t('lsetup.installTmloader')} note={t('lsetup.tmloaderNote')} />
            </div>
          </>
        )}
      </>
    );
    actions = (
      <>
        <button className="btn ghost" onClick={onGone}>{t('common.cancel')}</button>
        {fixesOnly
          ? <button className="btn primary" disabled={busy} onClick={saveFixes}>{t('lsetup.save')}</button>
          : <button className="btn primary" disabled={busy || (runner === 'wine' ? !r.wine : false)} onClick={start}>{repair ? t('lsetup.repair') : t('lsetup.start')}</button>}
      </>
    );
  }

  // Portal: the card's panel styles would otherwise trap the fixed overlay inside the side column.
  return createPortal(<Modal title={title} wide onClose={close} actions={actions}>{body}</Modal>, document.body);
}

/** Buttons (and the dialog) for one downloadable game: Set up, or Fixes / Repair / Log. */
function SetupActions({ game, st, reload }: { game: string; st: SetupStatus; reload: () => void }) {
  const t = useT();
  const [dlg, setDlg] = useState<{ mode: Mode; shown: boolean } | null>(null);
  const open = (mode: Mode) => setDlg({ mode, shown: true });
  const running = st.running === game;
  const gone = () => { setDlg(null); reload(); };
  return (
    <>
      <div className="row-btns">
        {running
          ? <button className="btn primary sm" onClick={() => open('install')}><Loader2 size={14} className="spin" /> {t('lsetup.open')}</button>
          : st.installed === null
            ? <button className="btn primary sm" onClick={() => open('install')}><Download size={14} /> {t('lsetup.setUp')}</button>
            : <>
                <button className="btn ghost sm" onClick={() => open('fixes')}><Wrench size={14} /> {t('lsetup.fixes')}</button>
                <button className="btn ghost sm" onClick={() => open('repair')}>{t('lsetup.repair')}</button>
              </>}
        {(st.installed !== null || running) && <button className="btn ghost sm" onClick={() => open('log')}><ScrollText size={14} /> {t('lsetup.log')}</button>}
      </div>
      {dlg && <LinuxSetupDialog key={dlg.mode} game={game} st={st} mode={running && dlg.mode !== 'log' ? 'install' : dlg.mode} shown={dlg.shown} onHide={() => setDlg({ ...dlg, shown: false })} onGone={gone} reload={reload} />}
    </>
  );
}

function HostDialog({ game, onClose }: { game: string; onClose: () => void }) {
  const { st, reload } = useSetupStatus(game);
  if (!st || !st.kind) return null;
  return <LinuxSetupDialog key={game} game={game} st={st} mode="install" shown onHide={onClose} onGone={onClose} reload={reload} />;
}

/** Mounted once in the app: opens the setup dialog when another part of the UI asks (openLinuxSetup). */
export function LinuxSetupHost() {
  const [game, setGame] = useState<string | null>(null);
  useEffect(() => {
    const f = (e: Event) => setGame((e as CustomEvent<{ game: string }>).detail.game);
    window.addEventListener(LINUX_SETUP_EVENT, f);
    return () => window.removeEventListener(LINUX_SETUP_EVENT, f);
  }, []);
  return game ? <HostDialog game={game} onClose={() => setGame(null)} /> : null;
}

export function LinuxGameSetupCard({ game }: { game: string }) {
  const t = useT();
  const hub = useHubState();
  const { st, reload } = useSetupStatus(game);
  if (!isNative || !st || !st.kind) return null;

  const addFolder = async () => {
    const r = await backend.addFolder?.().catch((e) => ({ added: false, message: String(e) }));
    if (!r) return;
    if (r.added) void backend.rescan().catch(() => undefined);
    if (r.message || r.added) hub.toast({ ok: r.added, message: r.message ?? t('lsetup.added') });
  };

  if (st.kind === 'download') {
    const running = st.running === game;
    return (
      <section className="panel lsetup-card">
        <b>{st.installed === null || running ? t('lsetup.title') : t('lsetup.linux')}</b>
        {running
          ? <p className="small"><Loader2 size={13} className="spin" /> {t('lsetup.running')}</p>
          : st.installed === null
            ? <><p className="dim small">{t('lsetup.cardText')}</p>{game === 'tmuf' && <p className="dim small">{t('lsetup.unitedKey')}</p>}</>
            : <p className="dim small mono ellip" title={st.prefix}>{st.prefix}</p>}
        <SetupActions game={game} st={st} reload={reload} />
      </section>
    );
  }
  if (st.kind === 'existing') {
    return (
      <section className="panel lsetup-card">
        <b>{t('lsetup.linux')}</b>
        <p className="dim small">{t('lsetup.existingText')}</p>
        <div className="row-btns"><button className="btn ghost sm" onClick={addFolder}><FolderPlus size={14} /> {t('lsetup.addFolder')}</button></div>
      </section>
    );
  }
  const id = steamId(game);
  return (
    <section className="panel lsetup-card">
      <b>{t('lsetup.linux')}</b>
      <p className="dim small">{t('lsetup.steamText')}</p>
      {id && <div className="row-btns"><button className="btn ghost sm" onClick={() => backend.openExternal(`https://store.steampowered.com/app/${id}/`)}><ExternalLink size={14} /> {t('lsetup.steamPage')}</button></div>}
    </section>
  );
}

function SectionRow({ game }: { game: string }) {
  const t = useT();
  const hub = useHubState();
  const { st, reload } = useSetupStatus(game);
  if (!st || st.kind !== 'download') return null;
  return (
    <div className="setrow">
      <div className="grow">
        <b>{hub.game(game)?.name ?? game}</b>
        <div className="dim small setnote">{st.running === game ? t('lsetup.running') : st.installed !== null ? t('lsetup.inPrefix') : t('lsetup.notSetUp')}</div>
        <SetupActions game={game} st={st} reload={reload} />
      </div>
    </div>
  );
}

export function LinuxSetupSection() {
  const t = useT();
  const { st } = useSetupStatus('tmnf');
  if (!isNative || !st) return null;
  const r = st.runners;
  const parts: string[] = [];
  if (r.wine) parts.push(t('lsetup.wineFound', { version: r.wine.version }));
  if (r.umu) parts.push(t('lsetup.sumUmu'));
  if (r.protons.length) parts.push(t('lsetup.sumProton', { n: r.protons.length }));
  return (
    <section className="panel">
      <b>{t('lsetup.sectionTitle')}</b>
      {parts.length ? <p className="dim small">{parts.join(' · ')}</p> : <><p className="dim small">{t('lsetup.noWine')}</p><InstallCommands cmds={r.commands} /></>}
      <SectionRow game="tmnf" />
      <SectionRow game="tmuf" />
    </section>
  );
}
