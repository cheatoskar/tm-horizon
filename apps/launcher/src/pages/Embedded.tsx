import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TmxUploadLink } from '../ui/TmxUpload';
import { insetRect, onWebLayer, overlayOpen, setEmbedded, webInset } from '../ui/webLayer';
import { ArrowLeft, ArrowRight, Bot, Check, CheckCircle2, ChevronDown, Download, ExternalLink, FileSearch, FolderOpen, Loader2, Package, Lock, Play, Puzzle, RotateCw, ServerOff, Wrench, X, XCircle } from 'lucide-react';
import { go, isTasProfile, mapResult, tmlName, useHubState } from '../state';
import { tr, useI18n, useT } from '../i18n';
import { CATALOG } from '../data/hub';
import { GameArt } from '../ui/common';
import { backend, type WebCheck, type WebDownload } from '../data/backend';
import { SITE_GROUPS, siteOfHost, sitesFor, sitesIn, tasOnly, type Site } from '../data/sites';
import { Modal } from '../ui/Modal';
import { SiteBanner } from '../ui/HeaderArt';
import { MapTools } from '../ui/MapTools';
import { inspectMap } from '../ui/mapInspect';
import { canGoBack, goBack } from '../data/navHistory';
import { AddonsPanel, ADDONS } from '../ui/AddonsPanel';

// The exchanges (Maps page, one site switcher grouped by game: TMX family, ManiaExchange, Item
// Exchange, TMTAS Exchange, TM RPG Trial) and ManiaPark (Skins & mods page) inside the launcher:
// a native child webview laid
// over the frame below the toolbar. Downloads of maps, replays, skins and mods are saved
// straight into the selected game's folders (src-tauri/src/web.rs) and listed in the shelf.

type Mode = 'maps' | 'skins';
/** Sites of one page: ManiaPark on the Skins page, everything else on the Maps page. */
const pageSites = (mode: Mode, game: string, tas: boolean) => sitesFor(game, tas).filter((s) => (mode === 'skins') === (s.kind === 'skins'));

const MAP_FOLDER: Record<string, string> = {
  forever: 'Documents\\TrackMania\\Tracks\\Challenges\\Downloaded',
  eswc: '<game folder>\\GameData\\Tracks\\Challenges\\Downloaded',
  legacy: '<game folder>\\GameData\\Tracks\\Challenges\\Downloaded',
  maniaplanet: 'Documents\\ManiaPlanet\\Maps\\Downloaded',
  tm2020: 'Documents\\Trackmania2020\\Maps\\Downloaded',
};
const SKIN_FOLDER: Record<string, string> = {
  forever: 'Skins\\Vehicles\\CarCommon · mods in Skins\\<Environment>\\Mod',
  maniaplanet: 'Skins\\Models\\<Car> · mods in Skins\\<Environment>\\Mod',
  tm2020: 'Skins\\Models\\CarSport · mods in Skins\\Stadium\\Mod',
};

/** Site icons, fetched once per host by the backend and cached. When the live fetch finds nothing
 * (or the app runs in the browser preview) the icon bundled in public/site-icons is used, and the
 * game cover if that is missing too. */
const icons = new Map<string, Promise<string | null>>();
/** Sites with an icon in public/site-icons (crisp, no network). */
const BUNDLED_ICONS = new Set(['100tmx.com', 'explorer.gbx.tools', '3d.gbx.tools', 'revalidate.gbx.tools', 'nc.gbx.tools', 'item.exchange', 'item.mania.exchange', 'maniapark.com', 'nations.tm-exchange.com',
  'original.tm-exchange.com', 'sm.mania.exchange', 'sunrise.tm-exchange.com', 'tm.mania.exchange', 'tmnf.exchange', 'tmrpgtrial.com',
  'tmtas.exchange', 'tmuf.exchange', 'trackmania.exchange']);

/** Bundled icon first, the site's own icon (fetched by the backend) only for sites without one, then the
 * game's cover art; every step falls through on a load error, so there is never an empty box. */
function SiteIcon({ host: h, game }: { host: string; game: string }) {
  const hub = useHubState();
  const [src, setSrc] = useState<string | null>(null);
  const [step, setStep] = useState<'bundled' | 'fetched' | 'cover'>('bundled');
  useEffect(() => {
    setSrc(null);
    setStep(h && BUNDLED_ICONS.has(h) ? 'bundled' : 'fetched');
  }, [h]);
  useEffect(() => {
    if (step !== 'fetched') return;
    if (!backend.web?.icon || !h) { setStep('cover'); return; }
    if (!icons.has(h)) icons.set(h, backend.web.icon(h).catch(() => null));
    let live = true;
    icons.get(h)!.then((s) => { if (!live) return; if (s) setSrc(s); else setStep('cover'); });
    return () => { live = false; };
  }, [h, step]);
  if (step === 'bundled' && h) return <img className="site-ico" src={`site-icons/${h}.png`} alt="" onError={() => setStep('fetched')} />;
  if (step === 'fetched' && src) return <img className="site-ico" src={src} alt="" onError={() => setStep('cover')} />;
  return <GameArt game={hub.game(game)} variant="cover" className="site-ico" />;
}

const base = (p: string | null) => (p ? p.split(/[\\/]/).pop()! : '');
const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };

export function Embedded({ mode, initial }: { mode: Mode; initial?: string }) {
  const hub = useHubState();
  // Pages this view went through (from its first page on): Back steps through them, and from the first page
  // back to the launcher page that opened it (a mod's companion page returns to the mod).
  const webStack = useRef<string[]>([]);
  const mountUrl = useRef(hub.webUrl);
  useEffect(() => {
    const u = hub.webUrl;
    const st = webStack.current;
    if (!u || (!st.length && u === mountUrl.current)) return;
    if (st.length > 1 && st[st.length - 2] === u) st.pop();
    else if (st[st.length - 1] !== u) st.push(u);
  }, [hub.webUrl]);
  const back = () => {
    if (webStack.current.length > 1 || !canGoBack()) void backend.web?.nav('back');
    else goBack(() => undefined);
  };
  const t = useT();
  // Route argument: "<game>" or "<game>@<site host>".
  const [initGame, initHost] = (initial ?? '').split('@');
  const tas = hub.mode === 'tas';
  const pick = (g?: string) => (g && pageSites(mode, g, tas).length ? g : null);
  const [gameId, setGameId] = useState(() => pick(initGame) ?? pick(hub.pendingWeb?.game) ?? pick(hub.selectedGame) ?? (mode === 'maps' ? 'tmnf' : 'tmuf'));
  const [menu, setMenu] = useState(false);
  // Add-ons panel (puzzle button): the native view hides while it is open, like for the site menu.
  const [addons, setAddons] = useState(false);
  // TAS-only sites (TMTAS Exchange) exist in TAS mode only and come first there, so the first entry is the default.
  const defaultHost = (g: string, want?: string) => {
    const list = pageSites(mode, g, tas);
    return (list.find((s) => s.host === want) ?? list[0])?.host ?? '';
  };
  const [siteHost, setSiteHost] = useState(() => defaultHost(gameId, initHost));
  const site: Site | undefined = pageSites(mode, gameId, tas).find((s) => s.host === siteHost) ?? pageSites(mode, gameId, tas)[0];
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const g = hub.game(gameId);
  const [ask, setAsk] = useState<WebDownload | null>(null);
  const [tools, setTools] = useState(false);
  // Reachability: a failed check hides the native view (Edge's own error page) and shows our panel.
  // Limit: in-page navigation errors after the first load are only caught when the page host
  // changes (the check runs again on each "web-page" event for a new host); a dead link inside
  // the same site still shows Edge's page.
  const [down, setDown] = useState<WebCheck | null>(null);
  const [retrying, setRetrying] = useState(false);
  const checkGen = useRef(0);
  // Dialogs anywhere in the app (ui/Modal.tsx) and the sidebar labels (ui/shell.tsx) move or hide the native view: see ui/webLayer.ts.
  const layer = useSyncExternalStore(onWebLayer, () => (overlayOpen() ? -1 : webInset()));
  const hidden = menu || addons || !!hub.confirm || !!hub.dialog || !!ask || !!down || tools || layer === -1;
  const siteParam = mode === 'skins' ? '' : site?.host ?? '';

  useEffect(() => {
    if (pick(initGame)) { setGameId(initGame); setSiteHost(defaultHost(initGame, initHost)); }
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Site switcher: ManiaPark lives on the Skins page, the exchanges on the Maps page. */
  const choose = (g: string, s: Site) => {
    setMenu(false);
    if ((s.kind === 'skins') !== (mode === 'skins')) { go(s.kind === 'skins' ? 'skins' : 'maps', s.kind === 'skins' ? g : `${g}@${s.host}`); return; }
    setGameId(g);
    setSiteHost(s.host);
  };

  // The user followed a link (or went back) to another listed site: the switcher follows without
  // reloading. Unknown hosts are shown by name.
  const pageHost = host(hub.webUrl);
  const pageSite = pageHost ? siteOfHost(pageHost) : undefined;
  useEffect(() => {
    const s = pageSite;
    if (!s || mode === 'skins' || s.kind === 'skins' || (tasOnly(s) && !tas) || (s.host === site?.host && s.games.includes(gameId))) return;
    const ng = s.games.includes(gameId) ? gameId : s.games.find((x) => hub.game(x)?.installed) ?? s.games[0];
    backend.web?.follow(ng, s.host).then(() => { setGameId(ng); setSiteHost(s.host); }).catch(() => {});
  }, [pageHost]); // eslint-disable-line react-hooks/exhaustive-deps

  // A map, replay, skin or mod was saved: offer the other installed games it fits.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    // Maps never ask: Play opens them in the exchange's own game, a download stays where that game keeps maps.
    const d = hub.downloads.find((x) => x.mode === mode && x.caught && x.success && x.path && x.kind !== 'file' && x.kind !== 'map' && !asked.current.has(x.path));
    if (!d || !backend.web?.targets) return;
    asked.current.add(d.path!);
    const games = hub.games.filter((x) => x.installed).map((x) => x.id);
    backend.web.targets(d.path!, d.kind, games).then((ts) => { if (ts.some((x) => x.folder && !x.here && !x.sharedWith)) setAsk(d); }).catch(() => {});
  }, [hub.downloads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show / move the native view; hide it while a menu or dialog would sit under it.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || !backend.web) return;
    if (hidden) { setEmbedded(false); backend.web.hide(); return; }
    setEmbedded(true);
    const pending = hub.pendingWeb?.mode === mode ? hub.pendingWeb.url : undefined;
    const gen = ++checkGen.current;
    backend.web.check?.(mode, pending ?? `https://${siteParam || 'maniapark.com'}/`)
      .then((c) => { if (gen === checkGen.current && c.reason !== 'ok') { backend.web?.hide(); setDown(c); } })
      .catch(() => {});
    backend.web.show(mode, gameId, insetRect(el.getBoundingClientRect()), pending, siteParam)
      .then(() => { setError(null); if (pending) hub.setPendingWeb(null); })
      .catch((e) => setError(String(e)));
    const place = () => backend.web!.bounds(insetRect(el.getBoundingClientRect()));
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    const offLayer = onWebLayer(place);
    return () => { setEmbedded(false); ro.disconnect(); window.removeEventListener('resize', place); offLayer(); };
  }, [mode, gameId, hidden, siteParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page went to another host (link or back): check that one too.
  const firstHost = useRef(true);
  useEffect(() => {
    if (firstHost.current) { firstHost.current = false; return; }
    if (!pageHost || down || !hub.webUrl.startsWith('https://')) return;
    const gen = ++checkGen.current;
    backend.web?.check?.(mode, hub.webUrl).then((c) => { if (gen === checkGen.current && c.reason !== 'ok') { backend.web?.hide(); setDown(c); } }).catch(() => {});
  }, [pageHost]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => {
    setRetrying(true);
    const gen = ++checkGen.current;
    const url = hub.webUrl.startsWith('https://') ? hub.webUrl : `https://${siteParam || 'maniapark.com'}/`;
    (backend.web?.check?.(mode, url) ?? Promise.resolve<WebCheck>({ reason: 'ok', status: null }))
      .then((c) => { if (gen === checkGen.current) setDown(c.reason === 'ok' ? null : c); })
      .catch(() => setDown(null))
      .finally(() => setRetrying(false));
  };

  // Layout cleanup: runs before the next page's layout effect (a passive cleanup would run after
  // it and hide the view the next page just showed).
  useLayoutEffect(() => () => { setEmbedded(false); backend.web?.hide(); void backend.web?.tipHide(); }, []);

  const shelf = hub.downloads.filter((d) => d.mode === mode);
  const folderNote = mode === 'skins' ? SKIN_FOLDER[g.family] : MAP_FOLDER[g.family];
  const host0 = site?.host ?? 'maniapark.com';
  // A site serves one game or several: the game it opens with is the current one when it fits, else
  // the first installed one; the chips under a multi-game site pick the game directly.
  const gameFor = (s: Site) => (s.games.includes(gameId) ? gameId : s.games.find((x) => hub.game(x)?.installed) ?? s.games[0]);
  const known = (s: Site) => s.games.filter((x) => hub.games.some((g) => g.id === x));

  return (
    <div className="browser">
      {mode === 'maps' && site && <SiteBanner host={site.host} />}
      <div className="bbar">
        <button className="bbtn" title={t('web.back')} onClick={back}><ArrowLeft size={17} /></button>
        <button className="bbtn" title={t('web.forward')} onClick={() => backend.web?.nav('forward')}><ArrowRight size={17} /></button>
        <button className="bbtn" title={t('web.reload')} onClick={() => backend.web?.nav('reload')}>{hub.webLoading ? <Loader2 size={16} className="spin" /> : <RotateCw size={16} />}</button>
        <div className="bgame">
          <button className="bgame-btn" onClick={() => setMenu(!menu)} title={mode === 'skins' ? t('web.gameFor') : t('web.exchangeFor')}>
            <SiteIcon host={mode === 'skins' ? 'maniapark.com' : site?.host ?? ''} game={gameId} />
            <span className="ellip">{pageHost && !pageSite ? pageHost : <>{g.short} · <b>{site?.label ?? 'ManiaPark'}</b></>}</span>
            <ChevronDown size={15} />
          </button>
          {menu && (
            <div className="psel-menu down site-menu">
              {SITE_GROUPS.map((grp) => {
                const list = sitesIn(grp, tas).filter((s) => known(s).length > 0);
                if (!list.length) return null;
                return (
                  <div key={grp} className="site-group">
                    <div className="site-group-head"><span className="grow">{t('web.group.' + grp)}</span></div>
                    {list.map((s) => {
                      const games = known(s);
                      const cur = mode === 'skins' ? 'maniapark.com' : site?.host;
                      const on = s.host === cur && games.includes(gameId);
                      const g0 = gameFor(s);
                      const chips = games.length > 1 && games.length <= 8 && s.kind !== 'tools';
                      const names = games.map((x) => hub.game(x)?.short ?? x);
                      return (
                        <div key={s.host} className={'site-row' + (on ? ' on' : '')}>
                          <button className={'psel-item site-item' + (on ? ' on' : '')} onClick={() => choose(g0, s)} title={`${s.label} (${s.host})`}>
                            <SiteIcon host={s.host} game={g0} />
                            <span className="site-text">
                              <b className="ellip">{s.label}</b>
                              <span className="dim small ellip">{chips ? s.host : `${names.length > 3 ? names.slice(0, 3).join(', ') + ' …' : names.join(', ')} · ${s.host}`}</span>
                            </span>
                            <span className="psel-check">{on && <Check size={14} />}</span>
                          </button>
                          {chips && (
                            <div className="site-chips">
                              {games.map((x) => {
                                const gv = hub.game(x);
                                return (
                                  <button key={x} className={'site-chip' + (on && x === gameId ? ' on' : '') + (gv?.installed ? '' : ' dim')} onClick={() => choose(x, s)} title={gv?.name ?? x}>{gv?.short ?? x}</button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="baddr" title={hub.webUrl}>
          <Lock size={13} />
          <span className="ellip" title={hub.webUrl || undefined}><b>{host(hub.webUrl) || host0}</b>{hub.webUrl ? hub.webUrl.replace(/^https?:\/\/[^/]+/, '') : '/'}</span>
        </div>
        {mode === 'maps' && <button className="btn ghost sm" onClick={() => setTools(true)} title={t('maptools.tip')}><Wrench size={14} /> {t('maptools.title')}</button>}
        {mode === 'skins' && <button className="btn ghost sm" onClick={() => go('skinlib', gameId)} title={t('skinlib.tip')}><Package size={14} /> {t('skinlib.installed')}</button>}
        <button className="bbtn" title={t('web.openBrowser')} onClick={() => backend.openExternal(hub.webUrl || `https://${host0}/`)}><ExternalLink size={16} /></button>
        {ADDONS.length > 0 && (
          <button className={'bbtn' + (addons ? ' on' : '')} title={t('addons.title')} aria-pressed={addons} onClick={() => { setMenu(false); setAddons(!addons); }}><Puzzle size={16} /></button>
        )}
      </div>

      {ask && <InstallInto d={ask} onClose={() => setAsk(null)} />}
      {tools && <MapTools onClose={() => setTools(false)} onOpen={(g, s) => { setTools(false); choose(g, s); }} game={gameId} />}

      <div className="bframe live" ref={frame}>
        {addons && <AddonsPanel onClose={() => setAddons(false)} onReload={() => { setAddons(false); backend.web?.nav('reload'); }} />}
        {hub.webLoading && !down && <div className="bload" />}
        {down && <SiteDown c={down} host={host0} game={gameId} retrying={retrying} onRetry={retry}
          onOpen={() => backend.openExternal(hub.webUrl || `https://${host0}/`)} label={mode === 'skins' ? 'ManiaPark' : site?.label ?? host0} />}
        {!down && error && <div className="bframe-msg"><XCircle size={18} /> {error}</div>}
        {!down && !error && <div className="bframe-msg dim"><Loader2 size={18} className="spin" /> {t('web.loading', { site: host0 })}</div>}
      </div>

      <div className="shelf">
        <div className="shelf-note dim small"><Download size={13} /> {t(mode === 'skins' ? 'web.skinsGo' : 'web.mapsGo', { game: g.short, folder: folderNote })}</div>
        {mode === 'maps' && <TmxUploadLink />}
        {shelf.map((d) => <ShelfItem key={(d.path ?? d.url) + d.mode} d={d} />)}
        {hub.toasts.map((t) => (
          <div className={'shelf-toast' + (t.ok === false ? ' bad' : '')} key={t.id}>
            <span className="grow">{t.message}{t.command && <code>{t.command}</code>}</span>
            {t.actions?.map((a) => <button key={a.label} className="btn ghost sm" onClick={() => { a.run(); hub.dismiss(t.id); }}>{a.label}</button>)}
            <button className="bbtn sm" aria-label={tr('common.close')} onClick={() => hub.dismiss(t.id)}><X size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Our own "site not reachable" panel, shown instead of Edge's error page. */
function SiteDown({ c, host: h, game, label, retrying, onRetry, onOpen }: { c: WebCheck; host: string; game: string; label: string; retrying: boolean; onRetry: () => void; onOpen: () => void }) {
  const t = useT();
  const { locale } = useI18n();
  const known = CATALOG.find((e) => e.url && host(e.url) === h);
  const last = known?.checked && known.status !== 'unclear'
    ? t('web.err.last', { state: t(known.status === 'alive' ? 'web.err.online' : 'web.err.dead'), date: new Date(known.checked).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) })
    : null;
  return (
    <div className="bdown">
      <div className="bdown-head"><SiteIcon host={h} game={game} /><b>{label}</b></div>
      <ServerOff size={30} className="bdown-ico" />
      <h3>{t('web.err.title')}</h3>
      <p>{t('web.err.' + c.reason, { status: String(c.status ?? '') })}</p>
      <div className="bdown-btns">
        <button className="btn primary" disabled={retrying} onClick={onRetry}>{retrying ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />} {t('web.err.retry')}</button>
        <button className="btn ghost" onClick={onOpen}><ExternalLink size={15} /> {t('web.err.browser')}</button>
      </div>
      {last && <div className="dim small">{last}</div>}
    </div>
  );
}

/** "Install into": the download landed in the selected game; tick more installed games it fits. */
function InstallInto({ d, onClose }: { d: WebDownload; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const [targets, setTargets] = useState<import('../data/backend').CopyTarget[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const games = hub.games.filter((x) => x.installed).map((x) => x.id);
    backend.web!.targets(d.path!, d.kind, games).then((ts) => setTargets(ts.filter((x) => x.folder))).catch(() => {});
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => hub.game(id)?.short ?? id;
  const install = async () => {
    setBusy(true);
    try {
      const done = await backend.web!.copy(d.path!, d.kind, [...pick]);
      hub.toast({ message: done.length ? t('dl.done', { games: done.map(([gid]) => name(gid)).join(', ') }) : t('dl.nothing') });
      onClose();
    } catch (e) { hub.toast({ message: String(e), ok: false }); setBusy(false); }
  };
  const hint = d.kind === 'skin' ? 'dl.hintSkin' : d.kind === 'mod' ? 'dl.hintMod' : 'dl.hintMap';
  return (
    <Modal title={t('dl.title')} onClose={onClose} actions={<>
      <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
      <button className="btn primary" disabled={busy || pick.size === 0} onClick={install}>{t('dl.install')}</button>
    </>}>
      <p className="dim small ellip" title={d.path ?? ''}>{base(d.path)}</p>
      <ul className="dl-targets">
        {targets.map((x) => {
          const fixed = x.here || !!x.sharedWith;
          const on = x.here || pick.has(x.game);
          return (
            <li key={x.game}>
              <label className={fixed ? 'dim' : ''}>
                <input type="checkbox" checked={on} disabled={fixed || busy}
                  onChange={() => setPick((p) => { const n = new Set(p); if (n.has(x.game)) n.delete(x.game); else n.add(x.game); return n; })} />
                <b>{name(x.game)}</b>
                <span className="dim small">{x.here ? t('dl.here') : x.sharedWith ? t('dl.shared', { game: name(x.sharedWith) }) : ''}</span>
              </label>
              <span className="mono small dim ellip" title={x.folder ?? ''}>{x.folder}</span>
            </li>
          );
        })}
      </ul>
      {targets.length > 0 && targets.every((x) => x.here || !!x.sharedWith) && <p className="dim small">{t('dl.allThere')}</p>}
      <p className="small">{t(hint)}</p>
      {d.kind === 'mod' && <button className="linkish small" onClick={() => { onClose(); go('mods', 'TM Vibrant Shaders'); }}>{t('dl.packsLink')}</button>}
    </Modal>
  );
}

function ShelfItem({ d }: { d: WebDownload }) {
  const hub = useHubState();
  const t = useT();
  const g = hub.game(d.game);
  const playable = d.kind === 'map' || d.kind === 'replay';
  const play = async () => {
    if (!d.path || !backend.openMap) return;
    hub.toast(mapResult(await backend.openMap(d.game, g.family === 'forever' ? tmlName(hub.profileFor(d.game)) : null, d.path)));
  };
  // Replays from TMTAS (or any replay on Forever): open them with a profile that has TMInterface on.
  const tasProfile = g.family === 'forever' && d.kind === 'replay' ? hub.profilesFor(d.game).find((p) => p.real && isTasProfile(p) && tmlName(p)) : undefined;
  const openTmi = async () => {
    if (!d.path || !backend.openMap || !tasProfile) return;
    hub.toast(mapResult(await backend.openMap(d.game, tmlName(tasProfile), d.path)));
  };
  return (
    <div className="shelf-item">
      <span className="caught-ico">{d.success === null ? <Loader2 size={16} className="spin" /> : d.success ? <CheckCircle2 size={16} /> : <XCircle size={16} />}</span>
      <div className="grow min0">
        <b className="ellip" title={d.path ?? undefined}>{base(d.path)}</b>
        <div className="dim small ellip" title={d.folder ?? ''}>{d.success === false ? t('web.failed') : t('web.kind.' + d.kind)} · {d.folder}</div>
      </div>
      {playable && d.success && (
        <button className="btn play sm" disabled={!g.installed} onClick={play} title={g.installed ? t('web.playWith', { game: g.short }) : t('common.notInstalled')}>
          <Play size={14} fill="currentColor" /> {t('common.play')}
        </button>
      )}
      {d.kind === 'map' && d.success && d.path && <button className="btn ghost sm" onClick={() => inspectMap({ path: d.path! })} title={t('mapinfo.inspectTip')}><FileSearch size={14} /> {t('mapinfo.inspect')}</button>}
      {tasProfile && d.success && <button className="btn ghost sm" onClick={openTmi} title={t('web.tmiTip', { profile: tasProfile.name })}><Bot size={14} /> {t('web.openTmi')}</button>}
      {d.success && <button className="btn ghost sm" onClick={() => d.path && backend.reveal?.(d.path)}><FolderOpen size={14} /> {t('common.folder')}</button>}
      <button className="bbtn sm" aria-label={t('common.remove')} onClick={() => hub.setDownloads((list) => list.filter((x) => x !== d))}><X size={14} /></button>
    </div>
  );
}
