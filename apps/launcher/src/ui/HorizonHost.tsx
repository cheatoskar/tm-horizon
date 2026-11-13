// Horizon Client (user-facing name of Horizon Host: the in-game menu + its modules = plugins): the
// main card at the top of the ESWC/Sunrise/Original and Forever game pages, and the "Horizon modules"
// list on the Mods page. Internal ids, paths and the TMLoader product name stay "Horizon Host". Rust side: src-tauri/src/horizonhost.rs
// (logic, tests) and horizoncmds.rs (commands). Nothing is written before the user confirmed a
// dialog that lists every file; any dinput8.dll is backed up first and can be put back.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArchiveRestore, ChevronRight, Copy, Download, FlaskConical, FolderOpen, Layers, Loader2, Play, RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import { backend, isNative, type ActionResult, type HhCatalog, type HhLog, type HhPlan, type HhPlugin, type HhSource, type HhStatus, type HhTarget, type HhTmlPlan, type HhTmlStatus, type HhWhere, type HhBackup } from '../data/backend';
import { go, tmlName, useHubState } from '../state';
import { fmtStamp, trOr, useI18n, useT } from '../i18n';
import { Modal } from './Modal';
import { TmxUploadLink } from './TmxUpload';
import { GameChip, SectionHead, Toggle } from './common';
import { horizonPluginName, isHorizonModule } from '@tm-hub/shared';
import { HorizonClientIntro } from './HorizonClientIntro';
import { moduleIconUrl, useModuleIconSet } from './moduleIcons';
import type { GameView, Profile } from '../data/types';

const api = () => backend.horizon;

/** The Horizon mark (ringed planet, same as the launcher's brand) in the card titles. */
export function HorizonTitle({ text }: { text: string }) {
  return <span className="hh-title"><img src="app-icon.png" alt="" width={22} height={22} />{text}</span>;
}

/** A plain sentence for the user; the technical text (URLs, status codes) only behind "Details". */
export function PlainError({ text, details }: { text: string; details?: string | null }) {
  const t = useT();
  return (
    <div className="hh-err small">
      <span className="warn"><AlertTriangle size={13} /> {text}</span>
      {details && <details className="hh-details"><summary className="dim">{t('common.details')}</summary><code>{details}</code></details>}
    </div>
  );
}

/** Where the host files come from (GitHub release or a local folder with a build): one small line
 * "Source: own folder · change"; the choice only opens by itself when there is no usable source. */
function SourceLine({ src, onChange }: { src: HhSource | null; onChange: () => void }) {
  const t = useT();
  const hub = useHubState();
  const h = api();
  const usable = !!src && !src.error && !!(src.version ?? src.tmlVersion);
  const [open, setOpen] = useState(false);
  if (!h || !src) return null;
  const pick = async () => {
    try { if (await h.pickSource()) onChange(); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
  };
  const dev = src.kind === 'dev';
  const noRelease = !dev && !!src.error && /404|not found/i.test(src.error);
  const shown = open || !usable;
  const what = dev ? `${t('hh.srcFolder')} (${(src.path ?? '').split(/[\/]/).filter(Boolean).pop() ?? ''})` : t('hh.srcRelease');
  return (
    <div className="hh-source small">
      {usable && <p className="dim hh-source-line" title={dev ? src.path ?? '' : undefined}>{t('hh.srcLine', { what })}{(src.version ?? src.tmlVersion) ? ` · ${src.version ?? src.tmlVersion}` : ''} · <button className="linkish small" onClick={() => setOpen(!open)} aria-expanded={shown}>{t('hh.srcChange')}</button></p>}
      {shown && (
        <>
          {!usable && <span className="dim hh-source-label">{t('hh.sourceAsk')}</span>}
          <div className="hh-choice" role="radiogroup" aria-label={t('hh.sourceAsk')}>
            <button role="radio" aria-checked={!dev} className={'hh-opt' + (!dev ? ' on' : '')} onClick={() => { if (dev) void h.setSource(null).then(onChange); }}>
              <b>{t('hh.optRelease')}</b>
              <span className="dim">{!dev && src.version ? src.version : !dev && src.error ? t('hh.noReleaseShort') : t('hh.optReleaseSub')}</span>
            </button>
            <button role="radio" aria-checked={dev} className={'hh-opt' + (dev ? ' on' : '')} onClick={pick} title={dev ? src.path ?? '' : undefined}>
              <b><FolderOpen size={13} /> {t('hh.optFolder')}</b>
              <span className="dim ellip">{dev ? (src.path ?? '').split(/[\/]/).filter(Boolean).pop() ?? '' : t('hh.sourcePick')}{dev && src.version ? ` · ${src.version}` : ''}</span>
            </button>
          </div>
        </>
      )}
      {src.error && <PlainError text={noRelease ? t('hh.noRelease') : t('hh.sourceFailed')} details={src.error} />}
    </div>
  );
}

function LogView({ where, has }: { where: HhWhere; has: boolean }) {
  const t = useT();
  const hub = useHubState();
  const [log, setLog] = useState<HhLog | null | undefined>(undefined);
  const load = () => { api()?.log(where).then(setLog).catch(() => setLog(null)); };
  useEffect(() => { setLog(undefined); }, [where.dir, where.profile]);
  const copy = () => {
    if (!log) return;
    const head = `Horizon Client log (host.dll, ${log.name}${log.cut ? ', end only' : ''})\nGame: ${where.game}${where.dir ? `\nFolder: ${where.dir}` : ''}${where.profile ? `\nTMLoader profile: ${where.profile}` : ''}\nTM Horizon ${backend.info?.().version ?? ''}\n\n`;
    navigator.clipboard?.writeText(head + '```\n' + log.text + '\n```').then(() => hub.toast({ message: t('hh.copied') })).catch(() => {});
  };
  return (
    <details className="hh-log" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && log === undefined) load(); }}>
      <summary className="small">{t('hh.log')}{!has && <span className="dim"> · {t('hh.noLogShort')}</span>}</summary>
      {log === undefined && has && <p className="dim small"><Loader2 size={13} className="spin" /></p>}
      {(log === null || (log === undefined && !has)) && <p className="dim small">{t('hh.noLog')}</p>}
      {log && (
        <>
          <div className="row-btns">
            <span className="dim small grow ellip" title={log.path}>{log.name}{log.modified ? ` · ${fmtStamp(log.modified)}` : ''}</span>
            <button className="btn ghost sm" onClick={load}><RefreshCw size={14} /></button>
            <button className="btn primary sm" onClick={copy}><Copy size={14} /> {t('hh.copyBug')}</button>
          </div>
          <pre className="hh-logtext">{log.text}</pre>
        </>
      )}
    </details>
  );
}

/** "Applies from the next start": clients before 0.3.0 load modules only at the start; newer ones switch them
 * while the game runs, except modules whose plugin.json says startup_only. */
const needsRestart = (st: { runtimeModules?: boolean; plugins: HhPlugin[] }) =>
  st.runtimeModules === false || st.plugins.some((p) => p.installed && p.startupOnly);

function PluginRow({ p, busy, onAction, hostReady }: { p: HhPlugin; busy: boolean; hostReady: boolean; onAction: (kind: 'install' | 'remove' | 'toggle', p: HhPlugin) => void }) {
  const t = useT();
  const { lang } = useI18n();
  // The host's plugin.json is English; TM Horizon's own modules have their text in the UI language.
  const desc = lang === 'en' ? p.description : trOr('hhmod.' + p.id, p.description ?? '') || null;
  const update = p.installed && p.available && p.installed !== p.available;
  const own = moduleIconUrl(p.id, useModuleIconSet());
  return (
    <div className={'hh-mod hh-plugin' + (p.compatible ? '' : ' off')} title={desc ?? p.name} data-id={p.id}>
      {own || p.icon ? <img className="mod-icon hh-icon" src={own ?? p.icon!} alt="" width={28} height={28} /> : <span className="mod-icon ph hh-icon">{p.name.slice(0, 2)}</span>}
      <span className="grow hh-mod-text">
        <span className="hh-mod-name">
          <b>{p.name}</b>
          {p.online === 'solo-only' && <span className="pill tiny">{t('hh.solo')}</span>}
          {!p.compatible && <span className="pill tiny warn-pill">{t('hh.notForGame')}</span>}
          {p.id === 'sample' && <span className="pill tiny">{t('hh.sample')}</span>}
        </span>
        {desc && <span className="dim small ellip hh-mod-desc">{desc}</span>}
      </span>
      {busy ? <Loader2 size={16} className="spin" /> : (
        <>
          {(!p.installed || update) && p.available && p.compatible && hostReady && (
            <button className={'btn sm ' + (update ? 'primary' : 'ghost')} onClick={() => onAction('install', p)}>
              {update ? <RefreshCw size={14} /> : <Download size={14} />} {update ? t('common.update') : t('common.install')}
            </button>
          )}
          {p.installed && <button className="btn ghost sm icon-only hh-mod-del" title={t('hh.removePlugin')} aria-label={t('hh.removePlugin')} onClick={() => onAction('remove', p)}><Trash2 size={14} /></button>}
          {p.installed && <Toggle on={p.enabled} label={p.name} onChange={() => onAction('toggle', p)} />}
        </>
      )}
    </div>
  );
}

/** Modules (built into the Horizon Client) and mods (separate plugins installed into it), see
 * packages/shared/src/horizon.ts. One row per module; mods only when there are some. */
function PluginLists({ plugins: raw, busy, hostReady, onAction }: { plugins: HhPlugin[]; busy: string | null; hostReady: boolean; onAction: (kind: 'install' | 'remove' | 'toggle', p: HhPlugin) => void }) {
  const t = useT();
  // Same module name on the card as in the Mods list, whatever an older install's plugin.json says.
  // The host's example plugin ("sample") is for plugin authors, not for players: hidden in public builds.
  const plugins = raw.filter((p) => !(__PUBLIC_BUILD__ && p.id === 'sample')).map((p) => ({ ...p, name: horizonPluginName(p.id, p.name) }));
  const modules = plugins.filter((p) => isHorizonModule(p.id));
  const mods = plugins.filter((p) => !isHorizonModule(p.id));
  const row = (p: HhPlugin) => <PluginRow key={p.id} p={p} busy={busy === 'p:' + p.id} hostReady={hostReady} onAction={onAction} />;
  return (
    <>
      {!modules.length && <p className="dim small">{t('hh.noPlugins')}</p>}
      <div className="hh-mods">{modules.map(row)}</div>
      {modules.some((p) => p.id === 'tmx-upload' && p.installed) && <TmxUploadLink />}
      {mods.length > 0 && (
        <>
          <h4 className="hh-h">{t('hh.mods')}</h4>
          <div className="hh-mods">{mods.map(row)}</div>
        </>
      )}
    </>
  );
}

/** Module on/off: the switch flips at once (no reload of the card); the backend calls run one
 * after the other (they write the same two small files), and on an error the switch flips back. */
function useModuleSwitch(patch: (id: string, on: boolean) => void) {
  const t = useT();
  const hub = useHubState();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  return (where: HhWhere, p: HhPlugin) => {
    const on = !p.enabled;
    patch(p.id, on);
    queue.current = queue.current
      .then(() => api()!.pluginEnable(where, p.id, on))
      .catch((e) => { patch(p.id, !on); hub.toast({ ok: false, message: `${t('hh.switchFailed', { name: p.name })} ${String(e)}` }); });
  };
}

const withSwitch = <T extends { plugins: HhPlugin[] }>(s: T | null, id: string, on: boolean, custom?: boolean): T | null =>
  s && { ...s, ...(custom ? { customPlugins: true } : {}), plugins: s.plugins.map((x) => (x.id === id ? { ...x, enabled: on } : x)) };

/** Folded state of the card per game (the module list stays open once opened). */
function useOpen(game: string): [boolean, (v: boolean) => void] {
  const key = 'hh.open.' + game;
  const [open, set] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  return [open, (v) => { set(v); try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private window */ } }];
}

/** The card's single row: chevron, title, version, Update, on/off. A click on the row folds the card. */
function HostRow({ open, setOpen, extra, update, toggle }: { open: boolean; setOpen: (v: boolean) => void; extra?: ReactNode; update?: ReactNode; toggle: ReactNode }) {
  const t = useT();
  return (
    <div className="hh-row" onClick={() => setOpen(!open)}>
      <button className="hh-chev" aria-expanded={open} aria-label={t('hh.plugins')} title={t('hh.plugins')} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <ChevronRight size={18} />
      </button>
      <h2 className="hh-h2"><HorizonTitle text={t('hh.title')} /></h2>
      {extra}
      <span className="grow" />
      {update && <span onClick={(e) => e.stopPropagation()}>{update}</span>}
      {toggle}
    </div>
  );
}

const ACT_CLASS: Record<string, string> = { replace: 'warn-pill', new: 'ok-pill', same: 'muted', keep: 'muted', chain: 'ok-pill', 'chain-replace': 'warn-pill' };

type Ask =
  | { kind: 'install'; plan: HhPlan }
  | { kind: 'remove'; restore: boolean }
  | { kind: 'restore'; backup: HhBackup }
  | { kind: 'putback' };

/** ESWC, Sunrise, Original: Legacy Loader (dinput8.dll) + horizon\ next to the game exe. The
 * switch installs the client (after the file list) or removes it again (after the same kind of list). */
export function HorizonLegacyCard({ g }: { g: GameView }) {
  const t = useT();
  const hub = useHubState();
  const h = api();
  const [targets, setTargets] = useState<HhTarget[] | null>(null);
  const [dir, setDir] = useState<string>('');
  const [st, setSt] = useState<HhStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [open, setOpen] = useOpen(g.id);
  const [adv, setAdv] = useState(false);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);
  const flip = useModuleSwitch((id, on) => setSt((s) => withSwitch(s, id, on, true)));

  useEffect(() => {
    if (!h) return;
    h.targets(g.id).then((l) => {
      setTargets(l);
      // A folder that already has the host first (e.g. the test copy), else the first install.
      const saved = backend.info?.().settings.selectedInstall?.[g.id];
      const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();
      const picked = saved ? l.find((x) => x.kind === 'install' && norm(x.dir) === norm(saved)) : undefined;
      setDir((d) => (d && l.some((x) => x.dir === d) ? d : (picked ?? l.find((x) => x.hostInstalled) ?? l[0])?.dir ?? ''));
    }).catch(() => setTargets([]));
  }, [g.id, hub.snapshot]);
  useEffect(() => {
    if (!h || !dir) { setSt(null); return; }
    setError(null);
    h.status(g.id, dir).then(setSt).catch((e) => { setSt(null); setError(String(e)); });
  }, [g.id, dir, n]);

  if (!isNative || !h) return null;
  const where: HhWhere = { game: g.id, dir };
  const done = (r: ActionResult) => { hub.toast(r); setBusy(null); reload(); };
  const prepare = async () => {
    setBusy('install');
    try { setAsk({ kind: 'install', plan: await h.prepare(g.id, dir) }); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(null);
  };
  const run = async () => {
    if (!ask) return;
    const a = ask;
    setAsk(null);
    setBusy(a.kind);
    if (a.kind === 'install') done(await h.apply(g.id, dir));
    else if (a.kind === 'remove') done(await h.remove(g.id, dir, a.restore));
    else if (a.kind === 'putback') done(await h.remove(g.id, dir, true));
    else done(await h.restore(g.id, dir, a.backup.id));
  };
  const plugin = async (kind: 'install' | 'remove' | 'toggle', p: HhPlugin) => {
    if (kind === 'toggle') { flip(where, p); return; }
    setBusy('p:' + p.id);
    done(kind === 'install' ? await h.pluginInstall(where, p.id) : await h.pluginRemove(where, p.id));
  };
  const starting = !!hub.launching[g.id] && hub.launching[g.id] !== 'running';
  const play = (safe: boolean) => { void hub.play(g.id, null, false, null, () => h.play(where, safe, g.name)); };
  const migrate = async () => { setBusy('migrate'); done(await h.migrateAutosave(g.id, dir)); };

  const installed = !!st?.installed;
  const hostOn = installed && st?.loader === 'horizon';
  const target = targets?.find((x) => x.dir === dir);
  const owner = (o: string | null | undefined) => (o === 'unknown' || !o ? t('hh.unknownDll') : o);
  const hasAutosavePlugin = !!st?.plugins.some((p) => (p.id === 'eswc-autosave' || p.id === 'autosave') && (p.available || p.installed));
  const showAdv = () => { setOpen(true); setAdv(true); };
  // On: install (file list first). Off: remove (file list first). Without a usable source the choice opens instead.
  const onSwitch = () => {
    if (!st) return;
    if (hostOn) setAsk({ kind: 'remove', restore: !st.chained && !!st.previous });
    // No client release to install from: say so (the switch otherwise looks dead) and open the source choice.
    else if (!st.source.version) { hub.toast({ ok: false, message: t('hh.noRelease') }); showAdv(); }
    else void prepare();
  };
  const switchBusy = busy === 'install' || busy === 'remove' || busy === 'putback' || busy === 'restore';

  return (
    <section className={'panel hh-card' + (open ? ' open' : '')}>
      <HostRow open={open} setOpen={setOpen}
        extra={<>
          {installed && <span className="dim small hh-ver">{st!.installed}</span>}
          {targets && targets.length > 1 && target && <span className="dim small ellip hh-where" title={dir}>{target.kind === 'instance' ? target.label : target.label || dir}</span>}
        </>}
        update={installed && st?.update ? <button className="btn primary sm" disabled={!!busy} onClick={prepare} title={t('hh.updateTo', { v: st.source.version ?? '' })}><RefreshCw size={14} /> {t('common.update')}</button> : null}
        toggle={<Toggle on={hostOn} busy={switchBusy} disabled={!st} label={t('hh.title')} onChange={onSwitch} />} />
      {error && <PlainError text={t('hh.statusFailed')} details={error} />}
      {targets && targets.length === 0 && <p className="dim small">{t('hh.noTargets')}</p>}
      {installed && st && st.loader === 'other' && <div className="notice slim hh-note"><AlertTriangle size={16} /><div className="small grow">{t('hh.loaderOther', { owner: owner(st.loaderOwner) })}</div><button className="btn ghost sm" disabled={!!busy || !st.source.version} onClick={prepare}>{t('hh.reinstall')}</button></div>}
      {installed && st && st.loader === 'missing' && <div className="notice slim hh-note"><AlertTriangle size={16} /><div className="small grow">{t('hh.loaderMissing')}</div><button className="btn ghost sm" disabled={!!busy || !st.source.version} onClick={prepare}>{t('hh.reinstall')}</button></div>}
      {open && st && (
        <div className="hh-body">
          {installed && st.chained === 'ESWC Autosave' && !st.autosaveMigrated && hasAutosavePlugin && (
            <div className="tool-card">
              <Layers size={18} />
              <div className="grow small">{t('hh.migrateText')}</div>
              {busy === 'migrate' ? <Loader2 size={16} className="spin" /> : <button className="btn primary sm" onClick={migrate}>{t('hh.migrate')}</button>}
            </div>
          )}
          {installed ? (
            <>
              <PluginLists plugins={st.plugins} busy={busy} hostReady={installed} onAction={plugin} />
              {needsRestart(st) && <p className="dim small hh-foot">{t('hh.nextStart')}</p>}
            </>
          ) : <p className="dim small">{t('hh.oneLine')} {t('hh.recommendTip')}</p>}

          <details className="hh-adv" open={adv} onToggle={(e) => setAdv((e.target as HTMLDetailsElement).open)}>
            <summary className="small">{t('hh.advanced')}</summary>
            {/* One folder: its path. Several (installs, instances): pick here; the switch above acts on it. */}
            {targets && targets.length > 1 && (
              <label className="select hh-folder">
                <span className="dim small">{t('hh.folder')}</span>
                <select value={dir} onChange={(e) => { setDir(e.target.value); if (targets.find((x) => x.dir === e.target.value)?.kind === 'install') void backend.setSelectedInstall?.(g.id, e.target.value).catch(() => undefined); }} title={dir}>
                  {targets.map((x) => <option key={x.dir} value={x.dir}>{x.kind === 'instance' ? `${x.label} (${t('hh.instance')})` : x.dir}{x.hostInstalled ? ` · Horizon ${x.hostInstalled}` : ''}</option>)}
                </select>
              </label>
            )}
            {targets && targets.length === 1 && dir && <p className="dim small hh-dirline" title={dir}>{t('hh.folderIs', { dir })}</p>}
            {installed && (
              <div className="row-btns">
                <button className="btn ghost sm" disabled={!!busy || starting} onClick={() => play(false)}>{starting ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {t('hh.play')}</button>
                <button className="btn ghost sm" disabled={!!busy || starting} title={t('hh.safeTip')} onClick={() => play(true)}><ShieldOff size={14} /> {t('hh.safe')}</button>
              </div>
            )}
            {target?.kind === 'install' && targets && targets[0]?.dir !== dir && <p className="dim small">{t('hh.otherFolderNote')}</p>}
            <SourceLine src={st.source} onChange={reload} />
            {installed && st.chained && <p className="dim small">{t('hh.chainedInfo', { owner: owner(st.chained) })}</p>}
            {st.autosaveMigrated && <p className="dim small">{t('hh.migrated')}</p>}
            <div className="hh-exe small">
              {st.exe?.known ? <span className="dim">{t('hh.exeKnown', { label: st.exe.known })}</span> : <span className="warn"><AlertTriangle size={13} /> {t(g.id === 'tm-original' ? 'hh.exeUnknownTmo' : 'hh.exeUnknown')}</span>}
              {st.exe && <code className="dim" title={st.exe.sha256}>{st.exe.name} · {st.exe.sha256.slice(0, 12)}…</code>}
            </div>
            {installed && <p className="dim small">{st.customPlugins ? (needsRestart(st) ? t('hh.enabledTip') : '') : t('hh.defaults')} {g.id !== 'tmnf' && g.id !== 'tmuf' ? t('hh.clipsOnly') : ''}</p>}
            {st.previous && installed && !st.chained && (
              <div className="tool-card">
                <ArchiveRestore size={18} />
                <div className="grow small">{t('hh.prevBackup', { owner: owner(st.previousOwner) })}<div className="dim">{fmtStamp(st.previous.created)}</div></div>
                <button className="btn ghost sm" disabled={!!busy} title={t('hh.putBackTip')} onClick={() => setAsk({ kind: 'putback' })}>{t('hh.putBack')}</button>
              </div>
            )}
            <LogView where={where} has={st.hasLog} />
            {st.backups.length > 0 && (
              <details className="eswc-backups">
                <summary className="dim small">{t('hh.backups', { n: st.backups.length })}</summary>
                {st.backups.slice(0, 8).map((b) => (
                  <div className="pd-mod" key={b.id}>
                    <span className="grow small"><b>{fmtStamp(b.created)}</b> <span className="dim">{b.reason} · {b.files.join(', ')}</span></span>
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => setAsk({ kind: 'restore', backup: b })}><ArchiveRestore size={14} /> {t('hh.restore')}</button>
                  </div>
                ))}
              </details>
            )}
            {installed && <div className="row-btns"><button className="btn ghost sm" disabled={!!busy} onClick={() => setAsk({ kind: 'remove', restore: !st.chained && !!st.previous })}><Trash2 size={14} /> {t('hh.remove')}</button></div>}
          </details>
        </div>
      )}
      {ask && st && (
        <Modal title={ask.kind === 'install' ? (ask.plan.installed ? t('hh.confirmUpdate', { v: ask.plan.version }) : t('hh.confirmInstall', { v: ask.plan.version })) : ask.kind === 'restore' ? t('hh.confirmRestore') : ask.kind === 'putback' ? t('hh.confirmPutBack') : t('hh.confirmRemove')}
          onClose={() => setAsk(null)}
          actions={<><button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={run}>{t('hh.go')}</button></>}>
          <div className="eswc-plan">
            <p className="dim small">{t('hh.filesIn', { dir })}</p>
            <ul>
              {ask.kind === 'install' && ask.plan.files.map((f) => <li key={f.path}><code>{f.path.replace(/\//g, '\\')}</code> <span className={'pill tiny ' + (ACT_CLASS[f.action] ?? '')}>{t('hh.act.' + f.action)}</span></li>)}
              {(ask.kind === 'remove' || ask.kind === 'putback') && ['dinput8.dll', 'horizon\\host.dll'].map((f) => <li key={f}><code>{f}</code> <span className="pill tiny warn-pill">{t('hh.act.remove')}</span></li>)}
              {ask.kind === 'remove' && st.chained && <li><code>dinput8.chain.dll → dinput8.dll</code> <span className="pill tiny ok-pill">{t('hh.act.putback')}</span></li>}
              {ask.kind === 'putback' && st.previous?.files.map((f) => <li key={'p' + f}><code>{f}</code> <span className="pill tiny ok-pill">{t('hh.act.putback')}</span></li>)}
              {ask.kind === 'restore' && ask.backup.files.map((f) => <li key={f}><code>{f.replace(/\//g, '\\')}</code> <span className="pill tiny warn-pill">{t('hh.act.replace')}</span></li>)}
            </ul>
            {ask.kind === 'install' && ask.plan.warnings.map((w) => <p key={w} className="small warn"><AlertTriangle size={13} /> {w}</p>)}
            {ask.kind === 'install' && ask.plan.chains && <p className="small"><Layers size={13} /> {t('hh.chains', { owner: owner(ask.plan.chains) })}</p>}
            {ask.kind === 'remove' && <p className="dim small">{t('hh.removeNote')}</p>}
            {ask.kind === 'remove' && st.previous && !st.chained && (
              <label className="check small"><input type="checkbox" checked={ask.restore} onChange={(e) => setAsk({ kind: 'remove', restore: e.target.checked })} /> {t('hh.restorePrevious', { owner: owner(st.previousOwner) })}</label>
            )}
            <p className="dim small">{t('hh.backupNote')}</p>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Nations/United Forever: TMLoader product "Horizon Host" (experimental). The switch is "on in
 * this TMLoader profile"; the first switch installs it into TMLoader (file list first). */
export function HorizonForeverCard({ g, profile }: { g: GameView; profile: Profile | null }) {
  const t = useT();
  const hub = useHubState();
  const h = api();
  const pname = tmlName(profile);
  const [st, setSt] = useState<HhTmlStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<HhTmlPlan | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [open, setOpen] = useOpen(g.id);
  const [adv, setAdv] = useState(false);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);
  const flip = useModuleSwitch((id, on) => setSt((s) => withSwitch(s, id, on)));
  useEffect(() => { h?.tmlStatus(g.id, pname).then(setSt).catch(() => setSt(null)); }, [g.id, pname, n, hub.snapshot]);
  if (!isNative || !h || !st) return null;
  const installed = st.installed.length > 0;
  const on = !!pname && st.profilesOn.includes(pname);
  const where: HhWhere = { game: g.id, profile: pname };
  const done = (r: ActionResult) => { hub.toast(r); setBusy(null); reload(); };
  const prepare = async () => {
    setBusy('install');
    try { setPlan(await h.tmlPrepare()); setPick(pname ? [pname] : []); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(null);
  };
  const plugin = async (kind: 'install' | 'remove' | 'toggle', p: HhPlugin) => {
    if (kind === 'toggle') { flip(where, p); return; }
    setBusy('p:' + p.id);
    done(kind === 'install' ? await h.pluginInstall(where, p.id) : await h.pluginRemove(where, p.id));
  };
  const onSwitch = async () => {
    if (!installed) {
      if (!st.source.tmlVersion) { setOpen(true); setAdv(true); return; }
      void prepare();
      return;
    }
    if (!pname) return;
    setBusy('tick');
    done(await h.tmlSetProfile(pname, !on));
  };
  const noSwitch = !st.tmloader || (installed && !pname);
  return (
    <section className={'panel hh-card' + (open ? ' open' : '')}>
      <HostRow open={open} setOpen={setOpen}
        extra={<>
          <span className="pill tiny warn-pill"><FlaskConical size={11} /> {t('hh.experimental')}</span>
          {installed && <span className="dim small hh-ver">{st.installed[st.installed.length - 1]}</span>}
          {installed && pname && <span className="dim small ellip hh-where">{t('hh.inProfile', { profile: pname })}</span>}
        </>}
        update={installed && st.update ? <button className="btn primary sm" disabled={!!busy || !st.source.tmlVersion} onClick={prepare} title={t('hh.updateTo', { v: st.source.tmlVersion ?? '' })}><RefreshCw size={14} /> {t('common.update')}</button> : null}
        toggle={<Toggle on={installed && on} busy={busy === 'install' || busy === 'tick' || busy === 'remove'} disabled={noSwitch}
          title={!st.tmloader ? t('hh.tmlNone') : installed && !pname ? t('hh.pickProfile') : undefined}
          label={pname ? t('hh.tmlOnIn', { profile: pname }) : t('hh.title')} onChange={onSwitch} />} />
      {open && (
        <div className="hh-body">
          {!st.tmloader && <p className="dim small">{t('hh.tmlNone')}</p>}
          {st.tmloader && !installed && <p className="dim small">{t('hh.oneLine')} {t('hh.recommendTip')}</p>}
          {installed && !pname && <p className="dim small">{t('hh.pickProfile')}</p>}
          {installed && pname && (
            <>
              <PluginLists plugins={st.plugins} busy={busy} hostReady={installed} onAction={plugin} />
              {needsRestart(st) && <p className="dim small hh-foot">{t('hh.nextStart')}</p>}
            </>
          )}
          <details className="hh-adv" open={adv} onToggle={(e) => setAdv((e.target as HTMLDetailsElement).open)}>
            <summary className="small">{t('hh.advanced')}</summary>
            <p className="dim small"><FlaskConical size={12} /> {t('hh.foreverOff')} {t('hh.subForever')}</p>
            <SourceLine src={st.source} onChange={reload} />
            {installed && on && (
              <div className="row-btns">
                <button className="btn ghost sm" disabled={!!busy || (!!hub.launching[g.id] && hub.launching[g.id] !== 'running')} title={t('hh.safeTip')} onClick={() => { void hub.play(g.id, null, false, null, () => h.play(where, true, g.name)); }}><ShieldOff size={14} /> {t('hh.safe')}</button>
              </div>
            )}
            {installed && pname && <LogView where={where} has={st.hasLog} />}
            {installed && <div className="row-btns"><button className="btn ghost sm" disabled={!!busy} onClick={() => setConfirmRemove(true)}><Trash2 size={14} /> {t('hh.remove')}</button></div>}
          </details>
        </div>
      )}
      {plan && (
        <Modal title={t('hh.confirmInstall', { v: plan.version })} onClose={() => setPlan(null)}
          actions={<><button className="btn ghost" onClick={() => setPlan(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={async () => { const p = pick; setPlan(null); setBusy('install'); done(await h.tmlApply(p)); }}>{t('hh.go')}</button></>}>
          <div className="eswc-plan">
            <p className="dim small">{t('hh.filesIn', { dir: plan.folder })}</p>
            <ul>{plan.files.map((f) => <li key={f.path}><code>{f.path.replace(/\//g, '\\')}</code> <span className={'pill tiny ' + (ACT_CLASS[f.action] ?? '')}>{t('hh.act.' + f.action)}</span></li>)}</ul>
            <p className="small">{t('hh.tmlProfiles')}</p>
            {st.profiles.map((p) => (
              <label key={p} className="check small"><input type="checkbox" checked={pick.includes(p)} onChange={(e) => setPick((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} /> {p}</label>
            ))}
            <p className="small warn"><FlaskConical size={13} /> {t('hh.tmlInstallNote')}</p>
          </div>
        </Modal>
      )}
      {confirmRemove && (
        <Modal title={t('hh.confirmRemove')} onClose={() => setConfirmRemove(false)}
          actions={<><button className="btn ghost" onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</button><button className="btn primary" onClick={async () => { setConfirmRemove(false); setBusy('remove'); done(await h.tmlRemove()); }}>{t('hh.go')}</button></>}>
          <p className="small">{t('hh.tmlRemoveNote', { profiles: st.profilesOn.join(', ') || '-' })}</p>
        </Modal>
      )}
    </section>
  );
}

/** Mods page, "Horizon plugins": every plugin of the host build with its games and where it is. */
export function HorizonPluginsBrowser() {
  const iconSet = useModuleIconSet();
  const t = useT();
  const hub = useHubState();
  const h = api();
  const [cat, setCat] = useState<HhCatalog | null>(null);
  const [dirOf, setDirOf] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { h?.catalog().then(setCat).catch(() => setCat(null)); }, [n]);
  if (!isNative || !h) return <p className="dim">{t('hh.onlyApp')}</p>;
  if (!cat) return <div className="hh-browser"><HorizonClientIntro /><p className="dim small"><Loader2 size={14} className="spin" /></p></div>;
  const act = async (key: string, f: () => Promise<ActionResult | string[]>) => {
    setBusy(key);
    try { const r = await f(); if (!Array.isArray(r)) hub.toast(r); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(null); setN((x) => x + 1);
  };
  // A module switch flips at once; the list is not read again (that reads every build package).
  const flipCat = (dir: string, p: { id: string; name: string }, where: HhWhere, on: boolean) => {
    const set = (v: boolean) => setCat((c) => c && { ...c, targets: c.targets.map((x) => (x.dir !== dir ? x : { ...x, plugins: x.plugins.map((y) => (y.id === p.id ? { ...y, enabled: v } : y)) })) });
    set(on);
    h.pluginEnable(where, p.id, on).catch((e) => { set(!on); hub.toast({ ok: false, message: `${t('hh.switchFailed', { name: p.name })} ${String(e)}` }); });
  };
  const shown = cat.plugins.map((p) => ({ ...p, name: horizonPluginName(p.id, p.name), later: false }));
  return (
    <div className="hh-browser">
      <HorizonClientIntro />
      <SectionHead title={t('hh.browseTitle')} sub={t('hh.browseSub')} />
      <SourceLine src={cat.source} onChange={() => setN((x) => x + 1)} />
      {cat.targets.length === 0 && <p className="dim small">{t('hh.noTargets')}</p>}
      <div className="modlist">
        {shown.map((p) => {
          const fits = cat.targets.filter((x) => !p.games.length || p.games.includes(x.game));
          const dir = dirOf[p.id] ?? (fits.find((x) => x.hostInstalled) ?? fits[0])?.dir ?? '';
          const tg = fits.find((x) => x.dir === dir);
          const st = tg?.plugins.find((x) => x.id === p.id);
          const where: HhWhere = { game: tg?.game ?? '', dir };
          const key = p.id + '|' + dir;
          return (
            <div className="modcard hh-plugcard" key={p.id}>
              {moduleIconUrl(p.id, iconSet) ? <img className="mod-icon" src={moduleIconUrl(p.id, iconSet)!} alt="" width={64} height={64} /> : <span className="mod-icon ph" style={{ width: 64, height: 64, fontSize: 20 }}>{p.name.slice(0, 2)}</span>}
              <div className="modcard-text">
                <div className="modcard-title">
                  <b>{p.name}</b>
                  {p.version && <span className="dim">{p.version}</span>}
                  {p.later && <span className="pill tiny">{t('hh.pluginLater')}</span>}
                  {p.id === 'sample' && <span className="pill tiny">{t('hh.sample')}</span>}
                  {p.online === 'solo-only' && <span className="pill tiny">{t('hh.solo')}</span>}
                </div>
                <p className="clamp2">{p.description ?? ''}</p>
                <div className="modcard-tags">{(p.games.length ? p.games : ['tmn-eswc', 'tm-sunrise', 'tm-original', 'tmnf', 'tmuf']).map((gid) => <GameChip key={gid} id={gid} />)}</div>
              </div>
              <div className="modcard-stats hh-plugact">
                {!p.later && fits.length > 0 && (
                  <label className="select">
                    <span className="dim small">{t('hh.target')}</span>
                    <select value={dir} onChange={(e) => setDirOf((m) => ({ ...m, [p.id]: e.target.value }))}>
                      {fits.map((x) => <option key={x.dir} value={x.dir}>{x.dir}{x.hostInstalled ? '' : ' · ' + t('hh.notInstalled')}</option>)}
                    </select>
                  </label>
                )}
                {!p.later && tg && !tg.hostInstalled && <span className="dim small">{t('hh.hostMissing')} <button className="linkish small" onClick={() => go('game', tg.game)}>{t('hh.openGame')}</button></span>}
                {!p.later && tg?.hostInstalled && st && (busy === key ? <Loader2 size={16} className="spin" /> : (
                  <div className="row-btns">
                    {!st.installed && <button className="btn primary sm" onClick={() => act(key, () => h.pluginInstall(where, p.id))}><Download size={14} /> {t('common.install')}</button>}
                    {st.installed && <span className="small">{t('hh.on')} <Toggle on={st.enabled} label={p.name} onChange={() => flipCat(tg.dir, p, where, !st.enabled)} /></span>}
                    {st.installed && <button className="btn ghost sm" title={t('hh.removePlugin')} onClick={() => act(key, () => h.pluginRemove(where, p.id))}><Trash2 size={14} /></button>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="dim small">{t('hh.foreverNote')}</p>
    </div>
  );
}
