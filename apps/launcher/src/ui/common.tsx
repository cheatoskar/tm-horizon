import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Download, ExternalLink, FlaskConical, Layers, Loader2, Play, Settings2, ShoppingBag, X } from 'lucide-react';
import { go, useHubState } from '../state';
import { backend, isNative } from '../data/backend';
import type { GameView } from '../data/types';
import type { ModView } from '../data/model';
import { tn, tp, tr, useT } from '../i18n';
import { LINUX_GUIDED, onLinux, openLinuxSetup } from './linuxOpen';
import { GenIcon, glyphForMod } from './GenIcon';
import { hubMod } from '../data/hub';
import { coverUrl, igdbCoverFocus } from '@tm-hub/shared/covers';
import ownCovers from '../generated/covers-own.json';

// TrackMania text formatting: $RGB colours, $o/$w/$n/$i/$s/$z/$t/$g, $$ literal.
export function TmText({ text, className, title }: { text: string; className?: string; title?: string }) {
  const parts: ReactNode[] = [];
  let color: string | undefined;
  let bold = false, italic = false;
  let buf = '';
  let key = 0;
  const flush = () => {
    if (buf) parts.push(<span key={key++} style={{ color, fontWeight: bold ? 700 : undefined, fontStyle: italic ? 'italic' : undefined }}>{buf}</span>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '$') { buf += c; continue; }
    const n = text[i + 1];
    if (n === undefined) break;
    if (n === '$') { buf += '$'; i++; continue; }
    if (/[0-9a-f]/i.test(n)) {
      flush();
      const hex = text.slice(i + 1, i + 4);
      if (/^[0-9a-f]{3}$/i.test(hex)) { color = '#' + hex; i += 3; } else { i += 1; }
      continue;
    }
    flush();
    const k = n.toLowerCase();
    if (k === 'o') bold = true;
    else if (k === 'i') italic = true;
    else if (k === 'g') color = undefined;
    else if (k === 'z') { color = undefined; bold = false; italic = false; }
    else if (k === 'l' || k === 'h' || k === 'p') {
      if (text[i + 2] === '[') { const e = text.indexOf(']', i + 2); if (e > 0) i = e - 1; }
    }
    i++;
  }
  flush();
  return <span className={className} title={title}>{parts}</span>;
}

export const stripTm = (s: string) => s.replace(/\$([0-9a-f]{1,3}|[a-z$]|[lhp]\[[^\]]*\])/gi, (m) => (m === '$$' ? '$' : ''));

export function Toggle({ on, onChange, label, busy, disabled, title }: { on: boolean; onChange: () => void; label: string; busy?: boolean; disabled?: boolean; title?: string }) {
  const t = useT();
  return (
    <button className={'toggle' + (on ? ' on' : '') + (busy ? ' busy' : '')} role="switch" aria-checked={on} aria-label={label} aria-busy={busy || undefined} disabled={disabled}
      title={busy ? t('common.saving') : title ?? (on ? t('common.toggleOn') : t('common.toggleOff'))}
      onClick={(e) => { e.stopPropagation(); if (!busy && !disabled) onChange(); }}>
      <span className="knob" />
    </button>
  );
}

export function SampleBadge({ title }: { title?: string }) {
  const t = useT();
  return <span className="sample" title={title ?? t('common.sampleTip')}><FlaskConical size={12} /> {t('common.sampleData')}</span>;
}

/** Remote pictures go through the backend's cache (fetched once, shown from disk); the browser
 * preview loads them directly. undefined while loading, null when it failed. */
const imgMemo = new Map<string, Promise<string | null>>();
/** Resolved pictures of this session: a remount (page change, list re-render) shows them at once. */
const imgDone = new Map<string, string>();
// Some hosts (GitHub attachments on S3) need 30+ s for 2 MB here; the download keeps going in the
// backend, so the UI waits long instead of starting a second download.
const IMG_TIMEOUT = 120000;
function fetchOnce(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), IMG_TIMEOUT);
    backend.image!(url).then((s) => { clearTimeout(timer); resolve(s); }, () => { clearTimeout(timer); resolve(null); });
  });
}
/** Long timeout, one retry after an error; failures are not memoised so a later mount tries again. */
function loadImage(url: string): Promise<string | null> {
  let p = imgMemo.get(url);
  if (!p) {
    p = fetchOnce(url).then((s) => s ?? fetchOnce(url)).then((s) => { if (!s) imgMemo.delete(url); else imgDone.set(url, s); return s; });
    imgMemo.set(url, p);
  }
  return p;
}
/** Warm the cache for a picture (hover preload). */
export function preloadImage(url: string | null | undefined) {
  if (url && backend.image && /^https:\/\//.test(url)) void loadImage(url);
}
export function useCachedImage(url: string | null | undefined, enabled = true): string | null | undefined {
  // The result is kept with the URL it belongs to: right after `url` changes, the previous answer (a failure
  // in particular) must not count for the new one (a fallback chain would otherwise skip its next step).
  const initial = (u: string | null | undefined) => (u && !backend.image ? u : u ? imgDone.get(u) : undefined);
  const [st, setSt] = useState<{ url: string | null | undefined; src: string | null | undefined }>(() => ({ url, src: initial(url) }));
  useEffect(() => {
    const setSrc = (src: string | null | undefined) => setSt({ url, src });
    if (!url) { setSrc(null); return; }
    if (!backend.image || !/^https:\/\//.test(url)) { setSrc(url); return; }
    const done = imgDone.get(url);
    if (done) { setSrc(done); return; }
    if (!enabled) return;
    let live = true;
    loadImage(url).then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [url, enabled]);
  return st.url === url ? st.src : url ? initial(url) : null;
}

/** Picture with a shimmer skeleton while loading, lazy-loaded when it scrolls into view, and a fallback when it failed. */
export function CachedImg({ url, alt = '', className = '', style, fallback }: { url: string | null | undefined; alt?: string; className?: string; style?: React.CSSProperties; fallback?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const src = useCachedImage(url, seen);
  // A picture that comes from the disk cache within a moment (or was shown before in this session) appears
  // at once: no skeleton and no fade. Only real downloads fade in.
  const mounted = useRef(performance.now());
  const [shown, setShown] = useState(() => !!src);
  const fast = useRef(!!src);
  useEffect(() => {
    if (!src) { setShown(false); return; }
    fast.current = fast.current || performance.now() - mounted.current < 150;
    setShown(fast.current);
  }, [src]);
  return (
    <span ref={ref} className={`cimg ${className}`} style={style}>
      {src === null ? (fallback ?? <span className="cimg-fail" />) : <>
        {(src === undefined || !shown) && <span className="cimg-skel" />}
        {src && <img src={src} alt={alt} decoding="async" onLoad={() => setShown(true)} onError={() => setShown(true)} style={fast.current ? undefined : { opacity: shown ? 1 : 0 }} />}
      </>}
    </span>
  );
}

/** Owner avatar of a GitHub repository URL (the icon when a mod has none of its own), else null. */
export function ownerAvatar(url: string | null | undefined, size = 96): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/|$)/i.exec(url ?? '');
  return m ? `https://github.com/${m[1]}.png?size=${size}` : null;
}

export function ModIcon({ mod, size = 44 }: { mod: Pick<ModView, 'icon' | 'name'>; size?: number }) {
  const m = mod as Partial<ModView>;
  // Own icon, else the website's generated tile (type glyph, colours by id); a picture that fails to load never stays broken.
  const [failed, setFailed] = useState(false);
  const src = useCachedImage(failed ? null : mod.icon ?? null);
  const hostRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const card = hostRef.current?.closest('.modcard');
    if (!card || !m.id) return;
    const on = () => { void import('../pages/Gallery').then((g) => g.loadGallery(m as ModView).then((l) => l.slice(0, 2).forEach(preloadImage))); };
    card.addEventListener('mouseenter', on, { once: true });
    return () => card.removeEventListener('mouseenter', on);
  }, [m.id]);
  return src
    ? <img ref={hostRef as React.RefObject<HTMLImageElement>} className="mod-icon" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setFailed(true)} />
    : <span ref={hostRef as React.RefObject<HTMLSpanElement>} className="mod-icon-host"><GenIcon seed={m.id ?? mod.name} glyph={glyphForMod(m.id ? hubMod(m.id)?.category : null, m.categories)} size={size} /></span>;
}

// cover = portrait box art, hero = wide key art, thumb = small crop of the hero.
/** Official covers loaded at runtime: IGDB's image CDN first (one source, 3:4 box art for every game,
 * packages/shared/src/covers.ts), else Steam's store CDN by app id (library 600x900, else its header as a
 * band). Fetched once through the app's picture cache (cached_image: https only, checked to be a picture by
 * its bytes, sent with the app's user agent, kept on disk), so it works offline and is never hot-linked per
 * render. Off with Settings > "Load game covers from the internet". Credits: Settings > About. */
const STEAM_CDN = 'https://shared.steamstatic.com/store_item_assets/steam/apps/';
export const coversOnline = () => backend.info?.()?.settings.coverDownloads !== false;

/** Own in-game screenshots composed by tools/make-own-covers.py (public/covers-own); empty = none. */
const OWN_COVERS = ownCovers as Record<string, { cover?: string; hero?: string }>;

/** TM Horizon's image proxy (the hub's /ext-img/, apps/web/deploy/ext-img.conf; the same paths the website uses):
 * our server fetches the IGDB, Steam or GameTDB picture, so the player's address does not reach them. Tried
 * first; when it does not deliver (hub down), the CDN itself, and the proxy is not asked again until the next start. */
const EXT_IMG = 'https://hub.tm-horizon.com/ext-img/';
let proxyDown = false;
function viaProxy(url: string): string | null {
  const igdb = /^https:\/\/images\.igdb\.com\/igdb\/image\/upload\/t_[a-z0-9_]+\/([a-z0-9]{2,32}\.(?:webp|jpg|png))$/.exec(url);
  if (igdb) return `${EXT_IMG}igdb/${igdb[1]}`;
  const steam = /^https:\/\/shared\.steamstatic\.com\/store_item_assets\/steam\/apps\/(\d{1,10})\/(library_600x900\.jpg|header\.jpg)$/.exec(url);
  if (steam) return `${EXT_IMG}steam/${steam[1]}/${steam[2]}`;
  const gametdb = /^https:\/\/art\.gametdb\.com\/wii\/cover\/([A-Z]{2})\/([A-Z0-9]{6}\.png)$/.exec(url);
  return gametdb ? `${EXT_IMG}gametdb/${gametdb[1]}/${gametdb[2]}` : null;
}

/** The game's IGDB cover, else Steam's library cover, else Steam's header (each through the proxy first); null when there is none. */
function useOnlineCover(game: string, appId: number | undefined, enabled: boolean): { src: string | null; header: boolean; igdb: boolean } {
  const base: [string | null, 'igdb' | 'cover' | 'header'][] = [[coverUrl(game), 'igdb'], [appId ? `${STEAM_CDN}${appId}/library_600x900.jpg` : null, 'cover'], [appId ? `${STEAM_CDN}${appId}/header.jpg` : null, 'header']];
  // The browser preview (no picture cache) cannot tell a failed proxy answer: CDN only there.
  const steps = base.flatMap(([u, kind]) => (u ? [{ url: backend.image ? viaProxy(u) : null, kind, proxy: true }, { url: u, kind, proxy: false }] : [])).filter((s) => s.url);
  const [stage, setStage] = useState(0);
  useEffect(() => { setStage(0); }, [game]);
  let at = stage;
  while (at < steps.length && steps[at]!.proxy && proxyDown) at++;
  const step = enabled && at < steps.length ? steps[at]! : null;
  const url = step?.url ?? null;
  const src = useCachedImage(url);
  useEffect(() => {
    if (!url || src !== null) return;
    if (step?.proxy) proxyDown = true;
    setStage(at + 1);
  }, [url, src, at, step?.proxy]);
  return { src: url ? src ?? null : null, header: step?.kind === 'header', igdb: step?.kind === 'igdb' };
}

/** TM Horizon's own cover: the game's colours, speed stripes, a horizon glow and the title. Used for the
 * games without a Steam page (ESWC, Sunrise, Original) and whenever no official cover can be loaded. */
export function DesignedCover({ game }: { game: Pick<GameView, 'name' | 'year'> }) {
  const id = useId().replace(/:/g, '');
  return (
    <>
      <svg className="art-design" viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id={id + 's'} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity=".2" /></linearGradient>
          <radialGradient id={id + 'g'} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#fff" stopOpacity=".38" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
          <linearGradient id={id + 'f'} x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".45" /></linearGradient>
        </defs>
        <g transform="rotate(-28 100 150)" fill={`url(#${id}s)`}>
          <rect x="-80" y="40" width="300" height="9" rx="4.5" /><rect x="-40" y="62" width="220" height="4" rx="2" />
          <rect x="-60" y="190" width="320" height="6" rx="3" /><rect x="0" y="206" width="160" height="3" rx="1.5" />
        </g>
        <ellipse cx="100" cy="258" rx="150" ry="34" fill={`url(#${id}g)`} />
        <path d="M-20 252 Q100 226 220 252" stroke="#fff" strokeOpacity=".55" strokeWidth="1.1" fill="none" />
        <rect width="200" height="300" fill={`url(#${id}f)`} />
      </svg>
      <span className="art-type">
        <small>TrackMania</small>
        <span>{game.name.replace(/^TrackMania\s*/i, '') || game.name}</span>
        <small>{game.year}</small>
      </span>
    </>
  );
}

/** `tile`: the box cover cropped to a wide tile (the dashboard's game strip), centred on the game's logo
 * (igdbCoverFocus); our designed cover when no cover can be loaded. Same in the public build, which ships
 * no box covers but loads the IGDB ones at runtime through the picture cache. */
export function GameArt({ game, variant = 'thumb', children, className = '' }: { game: GameView; variant?: 'cover' | 'hero' | 'thumb' | 'tile'; children?: ReactNode; className?: string }) {
  // Covers: own screenshot cover (covers-own) > IGDB > Steam (loaded at runtime, setting on) > bundled preview cover > our design.
  const own = OWN_COVERS[game.id];
  const heroArt = own?.hero ?? game.art?.hero;
  // The online cover is also wanted for a hero without wide key art (ESWC, Sunrise, Original): see below.
  const wantOnline = ((variant === 'cover' || variant === 'tile') && !own?.cover) || (variant === 'hero' || variant === 'thumb') && !heroArt;
  const steam = useOnlineCover(game.id, game.steamAppId ?? undefined, wantOnline && coversOnline());
  const online = steam.header ? null : steam.src;
  // A small thumb without wide art (ESWC, Sunrise, Original) crops the box cover.
  const coverSrc = own?.cover ?? online ?? game.art?.cover;
  const cropped = variant === 'thumb' && !heroArt && !!coverSrc;
  if (variant === 'tile') {
    const focus = !own?.cover && online && steam.igdb ? { objectPosition: `50% ${igdbCoverFocus(game.id)}%` } : undefined;
    return (
      <div className={`art art-thumb art-tile art-crop ${className}`} style={coverSrc ? undefined : { background: game.gradient }}>
        {coverSrc ? <img src={coverSrc} alt="" style={focus} loading="lazy" decoding="async" /> : <DesignedCover game={game} />}
        {children}
      </div>
    );
  }
  const src = variant === 'cover' ? coverSrc : variant === 'thumb' ? heroArt ?? coverSrc : heroArt;
  // No wide key art (Original, ESWC, Sunrise): the box cover, blurred and darkened, fills the hero,
  // and the box itself sits on the right at its own size instead of being upscaled.
  const box = variant === 'hero' && !src ? game.art?.cover ?? own?.cover ?? online : null;
  if (box) {
    return (
      <div className={`art art-hero art-boxed ${className}`}>
        <img className="art-blur" src={box} alt="" decoding="async" />
        <img className="art-box" src={box} alt="" decoding="async" />
        {children}
      </div>
    );
  }
  return (
    <div className={`art art-${variant}${cropped ? ' art-crop' : ''} ${className}`} style={src ? undefined : { background: game.gradient }}>
      {src
        ? <img src={src} alt="" loading={variant === 'hero' ? 'eager' : 'lazy'} decoding="async" />
        : <>
            <DesignedCover game={game} />
            {/* Only Steam's wide header exists: shown as a band across our own cover. */}
            {variant === 'cover' && steam.header && steam.src && <img className="art-steam-header" src={steam.src} alt="" decoding="async" />}
          </>}
      {children}
    </div>
  );
}

export function GameLogo({ game, className = '' }: { game: GameView; className?: string }) {
  return game.art?.logo
    ? <img className={'game-logo ' + className} src={game.art.logo} alt={game.name} />
    : <h1 className={'hero-title ' + className}>{game.name}</h1>;
}

/** Hub/catalog game ids that differ from the launcher's. */
const HUB_TO_LAUNCHER: Record<string, string> = { eswc: 'tmn-eswc', tmo: 'tm-original', tms: 'tm-sunrise', turbo: 'tm-turbo' };
const OTHER_GAMES: Record<string, string> = { tm2: 'TM²', maniaplanet: 'ManiaPlanet', tmo: 'Original', tms: 'Sunrise', turbo: 'Turbo' };

export function GameChip({ id }: { id: string }) {
  const { games } = useHubState();
  // Catalog entries may name games the launcher does not list: show the name instead of crashing.
  const g = games.find((x) => x.id === id || x.id === HUB_TO_LAUNCHER[id]);
  if (!g) return <span className="chip">{OTHER_GAMES[id] ?? id.toUpperCase()}</span>;
  return <span className={`chip fam-${g.family}`}>{g.short}</span>;
}

export function ProfileSelect({ game }: { game: GameView }) {
  const hub = useHubState();
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = hub.profilesFor(game.id);
  const cur = hub.profileFor(game.id);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  if (!list.length) return null;
  const key = game.family === 'forever' ? 'forever' : game.id;
  return (
    <div className="psel" ref={ref}>
      <button className={'psel-btn' + (open ? ' open' : '')} onClick={() => setOpen(!open)} title={t('psel.title')} aria-haspopup="menu" aria-expanded={open}>
        <Layers size={18} className="psel-icon" />
        <span className="psel-text">
          <span className="psel-label">{t('common.profile')}</span>
          <span className="psel-name">{cur?.name}</span>
        </span>
        <span className="psel-count">{tp('common.mods', cur?.mods.length ?? 0)}</span>
        <ChevronDown size={18} className="psel-chev" />
      </button>
      {open && (
        <div className="psel-menu">
          {list.map((p) => (
            <button key={p.id} className={'psel-item' + (p.id === cur?.id ? ' on' : '')}
              onClick={() => { hub.selectProfile(key, p.id); setOpen(false); }}>
              <span className="psel-check">{p.id === cur?.id && <Check size={14} />}</span>
              <span className="grow">{p.name}{!p.real && <em className="dim"> {t('profiles.unsaved')}</em>}</span>
              <span className="dim">{tp('common.mods', p.mods.length)}</span>
            </button>
          ))}
          <div className="psel-sep" />
          <button className="psel-item" onClick={() => { setOpen(false); go('profiles', key); }}>
            <span className="psel-check"><Settings2 size={14} /></span><span className="grow">{t('psel.manage')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function PlayButton({ game, size = 'lg' }: { game: GameView; size?: 'lg' | 'sm' }) {
  const hub = useHubState();
  const t = useT();
  if (!game.installed) {
    if (isNative) return <GetButton game={game} size={size} />;
    return game.store
      ? <a className={`btn get ${size}`} href={game.store.url} target="_blank" rel="noreferrer" title={t('play.storeTip', { store: game.store.label })} onClick={(e) => e.stopPropagation()}>{t('common.get')}</a>
      : <span className={`btn get ${size} disabled`} title={t('play.notSold')}>{t('common.notInstalled')}</span>;
  }
  const step = hub.launching[game.id];
  if (step) {
    const label = step === 'running' ? t('play.running') : step === 'waiting' ? t('play.waiting') : step === 'tmloader' ? t('play.tmloader') : t('play.starting');
    return (
      <button className={`btn play ${size} launching ${step}`} disabled aria-busy={step !== 'running'} title={label} onClick={(e) => e.stopPropagation()}>
        {step === 'running' ? <Play size={size === 'lg' ? 22 : 15} fill="currentColor" /> : <Loader2 size={size === 'lg' ? 20 : 14} className="spin" />}
        <span className="ellip">{label}</span>
      </button>
    );
  }
  return (
    <button className={`btn play ${size}`} onClick={(e) => { e.stopPropagation(); hub.play(game.id); }} title={t('play.tip')}>
      <Play size={size === 'lg' ? 22 : 15} fill="currentColor" /> {t('common.play')}
    </button>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useHubState();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div className={'toast' + (t.ok === false ? ' bad' : '')} key={t.id}>
          <div className="toast-row">
            <div className="grow">{t.message}</div>
            {t.actions?.map((a) => <button key={a.label} className={'btn sm ' + (a.primary ? 'primary' : 'ghost')} onClick={() => { a.run(); dismiss(t.id); }}>{a.label}</button>)}
            {(t.actions?.length || t.sticky) && <button className="bbtn sm" aria-label={tr('common.close')} onClick={() => dismiss(t.id)}><X size={14} /></button>}
          </div>
          {t.command && <code>{t.command}</code>}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const { confirm, setConfirm } = useHubState();
  const t = useT();
  if (!confirm) return null;
  const close = () => { setConfirm(null); confirm.onCancel?.(); };
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={'modal' + (confirm.sheet ? ' get-sheet' : '')} role="dialog" aria-modal>
        {confirm.sheet && <div className="get-art" style={confirm.art ? { backgroundImage: `url("${confirm.art}")` } : undefined} />}
        <h3>{confirm.title}</h3>
        <div className="modal-text">{confirm.text}</div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={close}>{confirm.cancel ?? t('common.cancel')}</button>
          {confirm.ok && <button className="btn primary" onClick={() => { setConfirm(null); confirm.onOk(); }}>{confirm.ok}</button>}
        </div>
      </div>
    </div>
  );
}

const MB = (n: number) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');

/** One full-width source row of the Get sheet: icon, name, short subtitle; a link when `onClick` is set. */
function GetRow({ icon, name, sub, onClick }: { icon: ReactNode; name: string; sub: ReactNode; onClick?: () => void }) {
  const body = <><span className="get-ico">{icon}</span><span className="grow"><b>{name}</b><span className="dim small">{sub}</span></span>{onClick && <ExternalLink size={15} className="dim" />}</>;
  return onClick ? <button className="get-row" onClick={onClick}>{body}</button> : <div className="get-row">{body}</div>;
}
const gameArt = (g: GameView) => g.art?.hero ?? g.art?.cover ?? null;

/** "Get" for a game that is not installed: official setup, store page or community page. */
export function GetButton({ game, size = 'lg' }: { game: GameView; size?: 'lg' | 'sm' }) {
  const hub = useHubState();
  const t = useT();
  const busy = hub.busy[game.id];
  const run = async (confirmed = false) => {
    try {
      await backend.gameRunSetup!(game.id, confirmed);
      hub.setBusy((b) => ({ ...b, [game.id]: t('get.setupRunning') }));
      hub.toast({ message: t('get.setupOpen', { game: game.name }) });
    } catch (e) { hub.toast({ message: String(e), ok: false }); }
  };
  const get = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // The first TrackMania and the console games: their game page says where to get them (emulator steps).
    if (game.family === 'classic' || game.family === 'console') {
      go('game', game.id);
      setTimeout(() => document.getElementById(game.family === 'console' ? 'console-setup' : 'where-get')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
      return;
    }
    // Linux: the guided setup (own prefix, runner, TMLoader), not the setup run in the main prefix.
    if (onLinux() && LINUX_GUIDED.includes(game.id)) { openLinuxSetup(game.id); return; }
    if (!backend.gameSource) return;
    if (game.family === 'maniaplanet' && game.install) {
      // ManiaPlanet is there, only the title pack is missing: the game page has the hint with Folder and Scan.
      go('game', game.id);
      setTimeout(() => document.getElementById('mp-pack')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
      return;
    }
    const src = await backend.gameSource(game.id);
    if (src.kind === 'download') {
      hub.setConfirm({
        title: t('get.title', { game: game.name }), sheet: true, art: gameArt(game),
        text: <>
          <GetRow icon={<Download size={18} />} name={t('get.official')} sub={`${src.note} · ${MB(src.size)}`} />
          <p className="dim small">{tn('get.downloadNote', { file: <span className="mono">{src.file}</span>, size: MB(src.size), host: <span className="mono">{new URL(src.url).host}</span> })}</p>
        </>,
        ok: t('common.download'),
        onOk: async () => {
          hub.setBusy((b) => ({ ...b, [game.id]: '0 %' }));
          try {
            const v = await backend.gameDownload!(game.id);
            if (!v.ok) { hub.toast({ message: v.message, ok: false }); hub.setBusy((b) => { const n = { ...b }; delete n[game.id]; return n; }); return; }
            if (v.needsConfirm) {
              hub.setBusy((b) => ({ ...b, [game.id]: t('get.waiting') }));
              hub.setConfirm({
                title: t('get.runTitle'), ok: t('get.runOk'),
                text: <><p>{v.message}</p><p className="dim small mono">SHA-256 {v.sha256}</p></>,
                onOk: () => run(true),
                onCancel: () => hub.setBusy((b) => { const n = { ...b }; delete n[game.id]; return n; }),
              });
            } else await run();
          } catch (err) {
            hub.toast({ message: String(err), ok: false });
            hub.setBusy((b) => { const n = { ...b }; delete n[game.id]; return n; });
          }
        },
      });
    } else if (src.kind === 'stores') {
      hub.setConfirm({
        title: t('get.title', { game: game.name }), ok: '', cancel: t('common.close'), onOk: () => {}, sheet: true, art: gameArt(game),
        text: <div className="get-rows">{src.stores.map((s) => <GetRow key={s.label} icon={<ShoppingBag size={18} />} name={s.label} sub={s.sub} onClick={() => backend.openExternal(s.url)} />)}</div>,
      });
    } else hub.setConfirm({
      // Not sold anymore (ESWC, Sunrise, Original): no download and no pointer to patched exes. Installed? Add folder.
      title: t('get.title', { game: game.name }), ok: backend.addFolder ? t('gm.addFolder') : '', cancel: t('common.close'), sheet: true, art: gameArt(game),
      text: <GetRow icon={<ShoppingBag size={18} />} name={t('get.notSold')} sub={t('get.notSoldSub')} />,
      onOk: async () => {
        const r = await backend.addFolder!();
        if (r.message !== 'Cancelled') hub.toast({ ok: r.added, message: r.added ? t('library.addedGame', { games: (r.games ?? []).join(', ') }) : (r.message ?? t('library.noGameThere')) });
      },
    });
  };
  if (busy) return <span className={`btn get ${size} disabled`}><Loader2 size={15} className="spin" /> {busy}</span>;
  return (
    <button className={`btn get ${size}`} onClick={get} title={t('get.tip')}>
      <Download size={size === 'lg' ? 18 : 14} /> {t('common.get')}
    </button>
  );
}

export function SectionHead({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {sub && <span className="dim">{sub}</span>}
      <div className="grow" />
      {right}
    </div>
  );
}
