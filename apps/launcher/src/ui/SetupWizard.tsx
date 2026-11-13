// First-run setup (also from Settings > Setup): found games, language and look, then per game what
// to set up (TMLoader, recommended mods, Horizon Host, TMX upload, Discord status), a review with
// every file list that needs one, and the run with progress. Skip works on every step; nothing is
// written before "Apply". Everything it installs shows up in the game's History with Undo.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Circle, Loader2, Minus, Moon, Sun, X } from 'lucide-react';
import { backend, isNative, type ActionResult, type HhPlan, type NativeEvent } from '../data/backend';
import { LANGS, useI18n } from '../i18n';
import { ACCENTS, go, useHubState, type Look } from '../state';
import type { GameView } from '../data/types';
import { UnitedHint } from './Classics';
import { GameArt } from './common';
import '../styles-wizard.css';

/** TMLoader mods offered for Nations/United Forever (when the index has them). */
const FOREVER_MODS: { id: string; on: boolean }[] = [
  { id: 'TM Vibrant Shaders', on: true },
  { id: 'Competition Patch', on: false },
];
const LEGACY = ['tmn-eswc', 'tm-sunrise', 'tm-original'];

type ItemKind = 'tmloader' | 'mod' | 'host' | 'hostForever' | 'upload' | 'discord';
interface Item { key: string; kind: ItemKind; game: string; label: string; what: string; on: boolean; note?: string; arg?: string }
type RunState = 'wait' | 'run' | 'ok' | 'fail' | 'skip';

/** "C:\Program Files (x86)\TmNationsForever" -> folder name and a middle-shortened path. */
export function shortPath(p: string, max = 36): { folder: string; short: string } {
  const parts = p.split(/[\\/]/).filter(Boolean);
  const folder = parts[parts.length - 1] ?? p;
  if (p.length <= max || parts.length < 3) return { folder, short: p };
  // Drive (or first part) and the game's own folder stay readable; the middle goes.
  const sep = p.includes('\\') ? '\\' : '/';
  return { folder, short: `${parts[0]}${sep}…${sep}${folder}` };
}

/** Fixed-size box cover, the same picture as the Library (GameArt: official cover loaded at runtime and cached,
 * else TM Horizon's own designed cover with the game's name). */
function GameThumb({ g }: { g: GameView }) {
  return (
    <span className="wiz-thumb" aria-hidden>
      <GameArt game={g} variant="cover" />
    </span>
  );
}

/** Waits for one native event (or gives up when `stop` resolves). */
function waitFor<T extends NativeEvent['type']>(type: T, stop: Promise<void>): Promise<Extract<NativeEvent, { type: T }> | null> {
  return new Promise((resolve) => {
    const off = backend.on?.((e) => { if (e.type === type) { off?.(); resolve(e as Extract<NativeEvent, { type: T }>); } });
    void stop.then(() => { off?.(); resolve(null); });
  });
}

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const hub = useHubState();
  const { t, choice, setLang } = useI18n();
  const [step, setStep] = useState(0);
  const installed = hub.games.filter((g) => g.installed);
  const has = (id: string) => installed.some((g) => g.id === id);
  const forever = has('tmnf') || has('tmuf');
  const tml = hub.snapshot.tmloader;
  const profile = tml.defaultProfiles?.TmForever ?? null;
  const [hostOk, setHostOk] = useState<Record<string, string>>({});
  const [uploadGames, setUploadGames] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [plans, setPlans] = useState<Record<string, HhPlan | string>>({});
  const [run, setRun] = useState<Record<string, { state: RunState; msg?: string }>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const skipWait = useRef<() => void>(() => {});
  const dialog = useRef<HTMLDivElement>(null);

  // What can be offered: Horizon Host sources and the TMX upload games.
  useEffect(() => {
    if (!isNative) {
      // Browser preview: sample choices, Apply only pretends.
      setItems([
        { key: 'tmloader', kind: 'tmloader', game: 'forever', label: 'TMLoader', what: t('wiz.what.tmloader'), on: true },
        { key: 'mod:TM Vibrant Shaders', kind: 'mod', game: 'forever', label: 'TM Vibrant Shaders', what: t('wiz.what.tmvs'), on: true, note: t('wiz.afterTml') },
        { key: 'upload:tmnf', kind: 'upload', game: 'forever', label: t('wiz.upload', { game: 'TMNF' }), what: t('wiz.what.upload'), on: false },
        { key: 'host:tmn-eswc', kind: 'host', game: 'tmn-eswc', label: 'Horizon Client', what: t('wiz.what.host'), on: false, note: t('wiz.recommended') },
        { key: 'discord', kind: 'discord', game: '', label: t('wiz.discord'), what: t('wiz.what.discord'), on: false },
      ]);
      return;
    }
    let dead = false;
    (async () => {
      const ok: Record<string, string> = {};
      const h = backend.horizon;
      if (h) {
        for (const g of LEGACY.filter(has)) {
          try {
            const dir = (await h.targets(g))[0]?.dir;
            if (!dir) continue;
            const st = await h.status(g, dir);
            if (st.source.version && !st.installed) ok[g] = dir;
          } catch { /* no source: not offered */ }
        }
        if (forever && tml.installed) {
          try {
            const st = await h.tmlStatus(has('tmuf') ? 'tmuf' : 'tmnf', profile);
            if (st.source.tmlVersion && !st.installed.length) ok.forever = st.source.tmlVersion;
          } catch { /* not offered */ }
        }
      }
      let up: string[] = [];
      try {
        const s = await invoke<{ games: { game: string; enabled: boolean }[] }>('tmx_upload_status');
        up = s.games.filter((g) => !g.enabled && has(g.game)).map((g) => g.game);
      } catch { /* upload not available */ }
      if (!dead) { setHostOk(ok); setUploadGames(up); setChecked(true); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The choices, built once the checks above are done.
  useEffect(() => {
    if (!isNative || !checked) return;
    const list: Item[] = [];
    const name = (id: string) => hub.games.find((g) => g.id === id)?.short ?? id;
    if (forever) {
      if (!tml.installed) list.push({ key: 'tmloader', kind: 'tmloader', game: 'forever', label: 'TMLoader', what: t('wiz.what.tmloader'), on: true });
      for (const m of FOREVER_MODS) {
        const mod = hub.mods.find((x) => x.id === m.id);
        if (!mod?.latest || mod.installedVersions.length) continue;
        list.push({ key: 'mod:' + m.id, kind: 'mod', game: 'forever', label: mod.name, what: t('wiz.what.' + (m.id === 'TM Vibrant Shaders' ? 'tmvs' : 'cp')), on: m.on, arg: m.id, note: tml.installed ? (profile ? t('wiz.inProfile', { profile }) : t('wiz.noProfile')) : t('wiz.afterTml') });
      }
      if (hostOk.forever) list.push({ key: 'hostForever', kind: 'hostForever', game: 'forever', label: 'Horizon Client', what: t('wiz.what.hostForever'), on: false, note: t('wiz.test') });
    }
    for (const g of LEGACY.filter((x) => hostOk[x])) list.push({ key: 'host:' + g, kind: 'host', game: g, label: 'Horizon Client', what: t('wiz.what.host'), on: false, note: t('wiz.recommended'), arg: hostOk[g] });
    for (const g of uploadGames) list.push({ key: 'upload:' + g, kind: 'upload', game: ['tmnf', 'tmuf'].includes(g) ? 'forever' : g, label: t('wiz.upload', { game: name(g) }), what: t('wiz.what.upload'), on: false, arg: g });
    const set = backend.info?.().settings;
    if (backend.info?.().discordAvailable && !set?.discordPresence) list.push({ key: 'discord', kind: 'discord', game: '', label: t('wiz.discord'), what: t('wiz.what.discord'), on: false });
    setItems(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  const chosen = useMemo(() => (items ?? []).filter((i) => i.on), [items]);
  const toggle = (key: string) => setItems((l) => l!.map((i) => (i.key === key ? { ...i, on: !i.on } : i)));

  // Review: Horizon Host needs its file list shown before anything is written.
  useEffect(() => {
    if (step !== 3 || !backend.horizon) return;
    for (const i of chosen.filter((x) => x.kind === 'host' && !(x.key in plans))) {
      backend.horizon.prepare(i.game, i.arg!).then((p) => setPlans((m) => ({ ...m, [i.key]: p }))).catch((e) => setPlans((m) => ({ ...m, [i.key]: String(e) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, chosen]);

  const finish = async () => {
    try { await backend.saveSettings?.({ setupDone: true }); } catch { /* asked again next start */ }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running && !hub.confirm) void finish(); };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, hub.confirm]);

  const mark = (key: string, state: RunState, msg?: string) => setRun((r) => ({ ...r, [key]: { state, msg } }));

  const apply = async () => {
    setStep(4);
    setRunning(true);
    setRun(Object.fromEntries(chosen.map((i) => [i.key, { state: 'wait' as RunState }])));
    if (!isNative) {
      for (const i of chosen) { mark(i.key, 'run'); await new Promise((r) => setTimeout(r, 500)); mark(i.key, 'ok', t('wiz.on')); }
      setRunning(false);
      setFinished(true);
      return;
    }
    let tmlReady = !!tml.installed;
    for (const i of chosen) {
      mark(i.key, 'run');
      let r: ActionResult;
      try {
        switch (i.kind) {
          case 'tmloader': {
            const dl = await backend.tmloaderSetup!.download();
            const stop = new Promise<void>((res) => { skipWait.current = res; });
            const done = waitFor('tmloaderSetupDone', stop);
            await backend.tmloaderSetup!.run(dl.path);
            mark(i.key, 'run', t('wiz.waitSetup'));
            const e = await done;
            r = e?.installed ? { ok: true, message: t('wiz.tmlDone') } : { ok: false, message: e ? t('wiz.tmlNot') : t('wiz.skipped') };
            // A fresh TMLoader has to start once before mods can go in.
            tmlReady = false;
            await backend.rescan().catch(() => undefined);
            break;
          }
          case 'mod': {
            if (!tmlReady) { mark(i.key, 'skip', t('wiz.afterTmlRun')); continue; }
            const mod = hub.mods.find((x) => x.id === i.arg);
            r = await backend.installMod(i.arg!, mod?.latest ?? '', profile ?? '', !!profile);
            break;
          }
          case 'hostForever': {
            await backend.horizon!.tmlPrepare();
            r = await backend.horizon!.tmlApply(profile ? [profile] : []);
            break;
          }
          case 'host': {
            const plan = plans[i.key];
            if (!plan || typeof plan === 'string') { mark(i.key, 'skip', typeof plan === 'string' ? plan : t('wiz.noPlan')); continue; }
            r = await backend.horizon!.apply(i.game, i.arg!);
            break;
          }
          case 'upload':
            await invoke('tmx_upload_set', { game: i.arg, enabled: true, confirm: true });
            r = { ok: true, message: t('wiz.on') };
            break;
          case 'discord':
            await backend.saveSettings!({ discordPresence: true });
            r = { ok: true, message: t('wiz.on') };
            break;
        }
      } catch (e) {
        r = { ok: false, message: String(e) };
      }
      mark(i.key, r.ok ? 'ok' : 'fail', r.message);
    }
    await backend.rescan().catch(() => undefined);
    setRunning(false);
    setFinished(true);
  };

  const steps = [t('wiz.s.games'), t('wiz.s.look'), t('wiz.s.setup'), t('wiz.s.check'), t('wiz.s.apply')];
  const groups = useMemo(() => {
    const g = new Map<string, Item[]>();
    for (const i of items ?? []) g.set(i.game, [...(g.get(i.game) ?? []), i]);
    return [...g.entries()];
  }, [items]);
  const groupName = (g: string) => (g === 'forever' ? 'Nations / United Forever' : g === '' ? t('wiz.general') : hub.games.find((x) => x.id === g)?.name ?? g);
  const doneCount = Object.values(run).filter((x) => x.state !== 'wait' && x.state !== 'run').length;

  return (
    <div className="wiz-backdrop">
      <div className="wiz" role="dialog" aria-modal="true" aria-labelledby="wiz-title" tabIndex={-1} ref={dialog}>
        <header className="wiz-head">
          <div>
            <h1 id="wiz-title">{t('wiz.title')}</h1>
            <ol className="wiz-steps" aria-label={t('wiz.steps')}>
              {steps.map((s, i) => <li key={s} className={i === step ? 'on' : i < step ? 'past' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>)}
            </ol>
          </div>
          {!running && <button className="btn ghost sm" onClick={finish}>{finished ? t('common.close') : t('wiz.skip')}</button>}
        </header>

        <div className="wiz-body">
          {step === 0 && (
            <>
              <p className="wiz-lead">{installed.length ? t('wiz.found', { n: installed.length }) : t('wiz.none')}</p>
              <div className="wiz-games">
                {installed.map((g) => (
                  <div className="wiz-game" key={g.id}>
                    <GameThumb g={g} />
                    <div className="wiz-game-text">
                      <b>{g.name}</b>
                      {g.install?.path && <div className="dim small wiz-path" title={g.install.path}>{shortPath(g.install.path).folder}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <p className="dim small">{t('wiz.foundNote')}</p>
              <UnitedHint compact />
            </>
          )}

          {step === 1 && (
            <div className="wiz-look">
              <label className="wiz-field">
                <b>{t('settings.languageLabel')}</b>
                <select className="text-in" value={choice} onChange={(e) => setLang(e.target.value)}>
                  <option value="">{t('settings.languageSystem')}</option>
                  {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              <div className="wiz-field">
                <b>{t('settings.theme')}</b>
                {/* Small live previews: the theme's background, a panel and the chosen accent. */}
                <div className="wiz-themes" role="radiogroup" aria-label={t('settings.theme')}>
                  {(['dark', 'midnight', 'light'] as Look['theme'][]).map((th) => (
                    <button key={th} role="radio" aria-checked={hub.look.theme === th} className={'wiz-theme th-' + th + (hub.look.theme === th ? ' on' : '')} onClick={() => hub.setLook({ theme: th })}>
                      <span className="wiz-theme-pv" aria-hidden><i className="pv-rail" /><i className="pv-panel" /><i className="pv-btn" /></span>
                      <span className="wiz-theme-name">{th === 'light' ? <Sun size={13} /> : <Moon size={13} />} {t('settings.theme.' + th)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="wiz-field">
                <b>{t('settings.accent')}</b>
                <div className="swatches" role="radiogroup" aria-label={t('settings.accent')}>
                  {ACCENTS.filter((a) => a !== 'teal').map((a) => (
                    <button key={a} role="radio" aria-checked={hub.look.accent === a} className={'swatch sw-' + a + (hub.look.accent === a ? ' on' : '')}
                      title={t('accent.' + a)} aria-label={t('accent.' + a)} onClick={() => hub.setLook({ accent: a })} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <>
              <p className="wiz-lead">{t('wiz.pick')}</p>
              {!items && <p className="dim"><Loader2 size={16} className="spin" /> {t('wiz.checking')}</p>}
              {items && !items.length && <p className="dim">{t('wiz.nothing')}</p>}
              {groups.map(([g, list]) => (
                <fieldset className="wiz-group" key={g}>
                  <legend>{groupName(g)}</legend>
                  {list.map((i) => (
                    <label className="wiz-item" key={i.key}>
                      <input type="checkbox" checked={i.on} onChange={() => toggle(i.key)} />
                      <div><b>{i.label}</b>{i.note && <span className="pill tiny muted">{i.note}</span>}<div className="dim small">{i.what}</div></div>
                    </label>
                  ))}
                </fieldset>
              ))}
            </>
          )}

          {step === 3 && (
            <>
              <p className="wiz-lead">{chosen.length ? t('wiz.review', { n: chosen.length }) : t('wiz.reviewNone')}</p>
              <ul className="wiz-review">
                {chosen.map((i) => {
                  const p = plans[i.key];
                  return (
                    <li key={i.key}>
                      <b>{i.label}</b> <span className="dim small">· {groupName(i.game)}</span>
                      <div className="dim small">{i.what}</div>
                      {i.kind === 'host' && !p && <div className="dim small"><Loader2 size={13} className="spin" /> {t('wiz.checking')}</div>}
                      {i.kind === 'host' && typeof p === 'string' && <div className="small warn"><AlertTriangle size={13} /> {p}</div>}
                      {i.kind === 'host' && p && typeof p !== 'string' && (
                        <>
                          <ul className="wiz-files mono small">{p.files.filter((f) => f.action !== 'same').map((f) => <li key={f.path}>{f.action === 'new' ? '+' : '~'} {f.path}</li>)}</ul>
                          {p.chains && <div className="small warn"><AlertTriangle size={13} /> {t('wiz.chains', { owner: p.chains })}</div>}
                          {p.warnings.map((w) => <div key={w} className="small warn"><AlertTriangle size={13} /> {w}</div>)}
                        </>
                      )}
                      {i.kind === 'upload' && <div className="dim small">{t('tmxup.confirm2')}</div>}
                    </li>
                  );
                })}
              </ul>
              {chosen.length > 0 && <p className="dim small">{t('wiz.undoNote')}</p>}
            </>
          )}

          {step === 4 && (
            <>
              <div className="wiz-progress" role="progressbar" aria-valuemin={0} aria-valuemax={chosen.length} aria-valuenow={doneCount}><span style={{ width: `${chosen.length ? (doneCount / chosen.length) * 100 : 100}%` }} /></div>
              <ul className="wiz-run" aria-live="polite">
                {chosen.map((i) => {
                  const r = run[i.key] ?? { state: 'wait' };
                  const Icon = r.state === 'ok' ? Check : r.state === 'fail' ? X : r.state === 'skip' ? Minus : r.state === 'run' ? Loader2 : Circle;
                  return (
                    <li key={i.key} className={'wiz-' + r.state}>
                      <Icon size={15} className={r.state === 'run' ? 'spin' : ''} aria-label={t('wiz.state.' + r.state)} />
                      <div className="grow"><b>{i.label}</b> <span className="dim small">· {groupName(i.game)}</span>{r.msg && <div className="small dim">{r.msg}</div>}</div>
                      {i.kind === 'tmloader' && r.state === 'run' && <button className="btn ghost sm" onClick={() => skipWait.current()}>{t('wiz.skip')}</button>}
                    </li>
                  );
                })}
              </ul>
              {finished && <p className="wiz-lead">{t('wiz.finished')}</p>}
            </>
          )}
        </div>

        <footer className="wiz-foot">
          {step > 0 && step < 4 && <button className="btn ghost" onClick={() => setStep(step - 1)}><ChevronLeft size={15} /> {t('wiz.back')}</button>}
          <div className="grow" />
          {step < 3 && <button className="btn primary" onClick={() => setStep(step + 1)}>{t('wiz.next')} <ChevronRight size={15} /></button>}
          {step === 3 && <button className="btn primary" disabled={!chosen.length || chosen.some((i) => i.kind === 'host' && !plans[i.key])} onClick={apply}>{t('wiz.apply')}</button>}
          {step === 4 && finished && (
            <>
              {chosen.some((i) => i.game && i.game !== '') && <button className="btn ghost" onClick={() => { void finish(); const g = chosen.find((i) => i.game)?.game; go('game', g === 'forever' ? (has('tmuf') ? 'tmuf' : 'tmnf') : g); }}>{t('wiz.toHistory')}</button>}
              <button className="btn primary" onClick={finish}>{t('wiz.done')}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Opens the wizard on a fresh install, and whenever the route is #/setup (Settings button). */
export function SetupWizardHost() {
  const { route } = useHubState();
  const [first, setFirst] = useState(() => isNative && backend.info?.().settings.setupDone === false);
  const open = first || route.page === 'setup';
  if (!open) return null;
  return <SetupWizard onClose={() => { setFirst(false); if (route.page === 'setup') go('settings'); }} />;
}

