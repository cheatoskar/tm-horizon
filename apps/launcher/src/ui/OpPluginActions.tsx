// One-click Openplanet plugins wherever one is shown (Mods list and search, plugin page, game page,
// "More projects"): Install into the game's Openplanet Plugins folder (a picker when the plugin fits
// several games here), Update when openplanet.dev has a newer version, Remove. Openplanet missing:
// its official installer first (useOpSetup). Rust: openplanet.rs (op_install / op_remove).
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpCircle, CheckCircle2, Download, Loader2, Trash2 } from 'lucide-react';
import { backend, isNative, type OpInstalledInfo, type OpPlugin } from '../data/backend';
import { opNewer, opTargets } from '../data/opPlugins';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { GameChip } from './common';
import { OpSetupAsk, useOpSetup } from './OpenplanetSetup';

/** Installed plugins per game folder, shared by every card (one read per game, refreshed after a change). */
const known = new Map<string, OpInstalledInfo | null>();
const loading = new Map<string, Promise<void>>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
function load(game: string, force = false): Promise<void> {
  if (!backend.openplanet) return Promise.resolve();
  if (!force && (known.has(game) || loading.has(game))) return loading.get(game) ?? Promise.resolve();
  const p = backend.openplanet.installed(game).then((i) => { known.set(game, i); }).catch(() => { known.set(game, null); }).finally(() => { loading.delete(game); notify(); });
  loading.set(game, p);
  return p;
}
export const reloadOpInstalled = (game: string) => load(game, true);

function useInstalled(games: string[]): Map<string, OpInstalledInfo | null> {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    subs.add(f);
    games.forEach((g) => { void load(g); });
    return () => { subs.delete(f); };
  }, [games.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return known;
}

type State = { game: string; op: boolean | null; version: string | null | undefined; have: boolean; update: boolean };
function stateOf(p: OpPlugin, game: string, info: OpInstalledInfo | null | undefined): State {
  const f = info?.plugins.find((x) => !x.isDir && x.identifier.toLowerCase() === p.identifier.toLowerCase())
    ?? info?.plugins.find((x) => x.identifier.toLowerCase() === p.identifier.toLowerCase());
  const have = !!f;
  return { game, op: info ? info.openplanet : null, version: f?.version, have, update: have && !!f?.version && !!p.version && opNewer(p.version, f.version) };
}

const gameName = (g: string) => (g === 'tm2020' ? 'Trackmania' : g === 'tm-turbo' ? 'Turbo' : 'ManiaPlanet');

function useActions(p: OpPlugin) {
  const hub = useHubState();
  const t = useT();
  const [busy, setBusy] = useState('');
  const run = async (game: string, what: 'install' | 'remove') => {
    if (!backend.openplanet) return;
    setBusy(game + what);
    const r = what === 'install' ? await backend.openplanet.install(game, p.id) : await (backend.openplanet.remove?.(game, p.identifier) ?? Promise.resolve({ ok: false, message: '' }));
    await reloadOpInstalled(game);
    setBusy('');
    hub.toast(r.ok ? { ok: true, message: `${what === 'install' ? t('op.installedHint', { name: p.name }) : t('op.removedHint', { name: p.name })}`, command: r.command ?? undefined } : r);
  };
  return { busy, run };
}

/** Openplanet missing for a game: its official installer first. */
function OpFirst({ game, onDone }: { game: string; onDone: () => void }) {
  const t = useT();
  const op = useOpSetup(game, onDone);
  const opBusy = op.phase === 'download' || op.phase === 'running';
  if (!op.can) return null;
  return (
    <>
      <button className="btn primary sm" disabled={opBusy} onClick={(e) => { e.stopPropagation(); op.setPhase('ask'); }} title={t('op.missing')}>
        {opBusy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} {t('opsetup.first')}
      </button>
      {op.phase === 'ask' && <span className="dlg-host" onClick={(e) => e.stopPropagation()}><OpSetupAsk update={false} onGo={op.start} onClose={() => op.setPhase('idle')} /></span>}
    </>
  );
}

/** One game's row: chip, version, Install / Update / Remove (plugin page, picker, game page). */
function GameRow({ p, s, busy, run }: { p: OpPlugin; s: State; busy: string; run: (g: string, w: 'install' | 'remove') => void }) {
  const t = useT();
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };
  return (
    <div className="op-row">
      <GameChip id={s.game} />
      <span className="grow dim small">
        {s.op === false ? t('op.missingShort') : s.have ? (s.version ? t('op.installedVer', { v: s.version }) : t('common.installed')) : t('common.notInstalled')}
        {s.update && <span className="pill tiny warn-pill"> {t('updates.available', { v: p.version })}</span>}
      </span>
      {s.op === false
        ? <OpFirst game={s.game} onDone={() => { void reloadOpInstalled(s.game); }} />
        : <>
            {(!s.have || s.update) && (
              <button className="btn primary sm" disabled={!!busy || !p.download || s.op === null} onClick={stop(() => run(s.game, 'install'))}>
                {busy === s.game + 'install' ? <Loader2 size={14} className="spin" /> : s.update ? <ArrowUpCircle size={14} /> : <Download size={14} />} {s.update ? t('common.update') : t('op.install')}
              </button>
            )}
            {s.have && (
              <button className="btn ghost sm" disabled={!!busy} onClick={stop(() => run(s.game, 'remove'))} title={t('op.removeTip')}>
                {busy === s.game + 'remove' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {t('op.remove')}
              </button>
            )}
          </>}
    </div>
  );
}

/** Install / Update / Remove for a plugin. `layout`: "card" = one button (a picker when it fits several
 * games), "page" = one row per game. Nothing when no game of the plugin is installed here. */
export function OpPluginActions({ p, layout = 'card' }: { p: OpPlugin; layout?: 'card' | 'page' }) {
  const hub = useHubState();
  const t = useT();
  const targets = opTargets(p, hub.games.filter((g) => g.installed).map((g) => g.id));
  const info = useInstalled(targets);
  const { busy, run } = useActions(p);
  const [pick, setPick] = useState(false);
  if (!isNative || !backend.openplanet || !targets.length) return null;
  const states = targets.map((g) => stateOf(p, g, info.get(g)));
  if (layout === 'page') {
    return <div className="op-rows">{states.map((s) => <GameRow key={s.game} p={p} s={s} busy={busy} run={run} />)}</div>;
  }
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };
  const withOp = states.filter((s) => s.op);
  const upd = states.filter((s) => s.update);
  const todo = withOp.filter((s) => !s.have);
  const picker = pick && (
    <span className="dlg-host" onClick={(e) => e.stopPropagation()}>
      <Modal title={<><Download size={18} /> {p.name}</>} onClose={() => setPick(false)} actions={<button className="btn ghost" onClick={() => setPick(false)}>{t('common.close')}</button>}>
        <p className="dim small">{t('op.pickGame')}</p>
        <div className="op-rows">{states.map((s) => <GameRow key={s.game} p={p} s={s} busy={busy} run={run} />)}</div>
        <p className="dim small">{t('op.restartHint')}</p>
      </Modal>
    </span>
  );
  let main: React.ReactNode;
  if (states.some((s) => s.op === null)) main = <button className="btn primary sm" disabled><Loader2 size={14} className="spin" /></button>;
  else if (!withOp.length) main = <OpFirst game={states[0].game} onDone={() => { void reloadOpInstalled(states[0].game); }} />;
  else if (upd.length) main = (
    <button className="btn primary sm" disabled={!!busy} onClick={stop(() => (states.length > 1 ? setPick(true) : run(upd[0].game, 'install')))}>
      {busy ? <Loader2 size={14} className="spin" /> : <ArrowUpCircle size={14} />} {t('common.update')}
    </button>
  );
  else if (todo.length) main = (
    <button className="btn primary sm" disabled={!!busy || !p.download} onClick={stop(() => (states.length > 1 ? setPick(true) : run(todo[0].game, 'install')))}
      title={states.length > 1 ? undefined : gameName(todo[0].game)}>
      {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t('op.install')}
    </button>
  );
  else main = (
    <button className="btn ghost sm op-have" onClick={stop(() => setPick(true))} title={t('op.manageTip')}>
      <CheckCircle2 size={14} className="good" /> {t('common.installed')}
    </button>
  );
  return <>{main}{picker}</>;
}

/** Update / Remove for a plugin installed in one game's folder (game page tiles); `p` from openplanet.dev's list. */
export function OpInstalledActions({ p, game }: { p: OpPlugin; game: string }) {
  const info = useInstalled([game]);
  const { busy, run } = useActions(p);
  const s = stateOf(p, game, info.get(game));
  if (!isNative || !s.have) return null;
  return <GameRow p={p} s={s} busy={busy} run={run} />;
}
