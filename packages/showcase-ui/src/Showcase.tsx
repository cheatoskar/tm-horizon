// Renders a validated Showcase (packages/shared/src/showcase.ts). One set of components for the launcher,
// the portal preview and (as static markup, react-dom/server) the website. Nothing here inserts raw HTML:
// every string is a React text node, Markdown goes through the tree parser, links
// and pictures were checked by the validator and are checked again where they are used.
import { createContext, useContext, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import {
  Bug, BookOpen, Camera, Car, Check, Clock, Cloud, Code2, Cpu, Download, Droplets, ExternalLink, Eye, Film, Flag, Flame, Gamepad2, Gift, Globe, Headphones, Heart,
  Image as ImageIcon, Keyboard, Languages, Layers, Lightbulb, Lock, Map as MapIcon, MessageCircle, Monitor, Moon, Mountain, MousePointer, Music, Package, Palette, Play, Puzzle,
  RefreshCw, Rocket, Route, Save, Settings, Share2, Shield, SlidersHorizontal, Sparkles, Star, Sun, Tag, Target, Timer, Trophy, Upload, Users, Volume2, Wand2, Wind, Wrench, Zap, Gauge,
  type LucideIcon,
} from 'lucide-react';
import { cleanHttpsUrl } from '@tm-hub/shared/links';
import {
  parseMarkdown, parseInline, parseVideoUrl,
  type MdBlock, type MdInline, type Showcase, type ShowcaseBlock, type ShowcaseIcon, type CompatStatus,
} from '@tm-hub/shared/showcase';

export interface ShowcaseLabels {
  compat: string; hotkeys: string; changelog: string; faq: string;
  game: string; status: string; keyHeader: string; action: string;
  works: string; partial: string; planned: string; no: string;
  before: string; after: string; compareHint: string;
  playVideo: string; videoNote: string; openVideo: string;
  install: string; version: string;
}

export const DEFAULT_LABELS: ShowcaseLabels = {
  compat: 'Compatibility', hotkeys: 'Hotkeys', changelog: 'Latest changes', faq: 'Questions',
  game: 'Game', status: 'Status', keyHeader: 'Key', action: 'Action',
  works: 'Works', partial: 'Partly', planned: 'Planned', no: 'No',
  before: 'Before', after: 'After', compareHint: 'Drag to compare',
  playVideo: 'Play video', videoNote: 'Loads from {provider} when you click.', openVideo: 'Open in browser',
  install: 'Install', version: 'Version',
};

export interface ShowcaseRelease { version: string; date?: string | null; notes: string }

export interface ShowcaseCtx {
  labels?: Partial<ShowcaseLabels>;
  /** Picture component of the host (the launcher caches pictures); default: a lazy img without referrer. */
  Img?: ComponentType<{ url: string; alt: string; className?: string }>;
  /** Display name of a game id (default: the id). */
  gameName?: (id: string) => string;
  /** Newest first. The changelog block shows the first `count`; without releases it is left out. */
  releases?: ShowcaseRelease[];
  /** Opens a link (launcher: system browser). Without it links are plain anchors. */
  onLink?: (url: string) => void;
  /** Install button action. Without it (and without installHref) install buttons are left out. */
  onInstall?: () => void;
  installHref?: string;
  /** Companion page for a "companion" button without its own url. */
  companion?: { label: string; url: string } | null;
  /** Gallery picture clicked (launcher: lightbox). */
  onZoom?: (urls: string[], index: number) => void;
}

const Ctx = createContext<ShowcaseCtx>({});
const fmt = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? '');
const useL = () => ({ ...DEFAULT_LABELS, ...(useContext(Ctx).labels ?? {}) });

const ICONS: Record<ShowcaseIcon, LucideIcon> = {
  sparkles: Sparkles, sun: Sun, moon: Moon, palette: Palette, zap: Zap, gauge: Gauge, keyboard: Keyboard, 'mouse-pointer': MousePointer, monitor: Monitor, camera: Camera,
  film: Film, image: ImageIcon, 'wand-2': Wand2, settings: Settings, 'sliders-horizontal': SlidersHorizontal, download: Download, upload: Upload, save: Save, shield: Shield,
  lock: Lock, heart: Heart, star: Star, flag: Flag, trophy: Trophy, timer: Timer, clock: Clock, map: MapIcon, route: Route, car: Car, wrench: Wrench, package: Package,
  layers: Layers, cpu: Cpu, 'gamepad-2': Gamepad2, headphones: Headphones, 'volume-2': Volume2, music: Music, globe: Globe, users: Users, 'message-circle': MessageCircle,
  'book-open': BookOpen, 'code-2': Code2, bug: Bug, rocket: Rocket, eye: Eye, flame: Flame, droplets: Droplets, wind: Wind, cloud: Cloud, mountain: Mountain,
  lightbulb: Lightbulb, 'refresh-cw': RefreshCw, check: Check, languages: Languages, 'share-2': Share2, puzzle: Puzzle, gift: Gift, tag: Tag, target: Target,
};

// ---------------------------------------------------------------- small parts

function A({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const { onLink } = useContext(Ctx);
  const url = cleanHttpsUrl(href);
  if (!url) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer nofollow"
      onClick={onLink ? (e) => { e.preventDefault(); onLink(url); } : undefined}>{children}</a>
  );
}

function Pic({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const { Img } = useContext(Ctx);
  const safe = cleanHttpsUrl(url);
  if (!safe) return null;
  if (Img) return <Img url={safe} alt={alt} className={className} />;
  return <img className={className} src={safe} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
}

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return n.v;
          case 'code': return <code key={i}>{n.v}</code>;
          case 'b': return <strong key={i}><Inline nodes={n.c} /></strong>;
          case 'i': return <em key={i}><Inline nodes={n.c} /></em>;
          case 'a': return <A key={i} href={n.href}><Inline nodes={n.c} /></A>;
        }
      })}
    </>
  );
}

/** The limited Markdown of text blocks, release notes and answers. */
export function Md({ source }: { source: string }) {
  const tree: MdBlock[] = parseMarkdown(source);
  return (
    <div className="sc-md">
      {tree.map((b, i) => {
        switch (b.t) {
          case 'h': return b.level === 3 ? <h3 key={i}><Inline nodes={b.c} /></h3> : <h4 key={i}><Inline nodes={b.c} /></h4>;
          case 'p': return <p key={i}><Inline nodes={b.c} /></p>;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ol>;
          case 'pre': return <pre key={i}><code>{b.v}</code></pre>;
        }
      })}
    </div>
  );
}

const Title = ({ children }: { children?: string }) => (children ? <h2 className="sc-title">{children}</h2> : null);

/** Click-to-load video: nothing is requested from the video site before the click (no thumbnail either). */
function Video({ url, poster, title }: { url: string; poster?: string; title?: string }) {
  const L = useL();
  const [on, setOn] = useState(false);
  const v = parseVideoUrl(url);
  if (!v) return null;
  const name = v.provider === 'youtube' ? 'YouTube' : v.provider === 'vimeo' ? 'Vimeo' : 'Streamable';
  const src = v.embed + (v.embed.includes('?') ? '&' : '?') + 'autoplay=1';
  return (
    <div className="sc-video" data-sc-video={src}>
      {on ? (
        <iframe src={src} title={title || name} loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
      ) : (
        <button type="button" className="sc-video-load" onClick={() => setOn(true)} data-sc-play>
          {poster && <Pic url={poster} alt="" className="sc-video-poster" />}
          <span className="sc-play"><Play size={28} fill="currentColor" /></span>
          <span className="sc-video-text"><b>{L.playVideo}</b><span>{fmt(L.videoNote, { provider: name })}</span></span>
        </button>
      )}
      <A href={v.watch} className="sc-video-open"><ExternalLink size={13} /> {L.openVideo}</A>
    </div>
  );
}

/** Before/after slider: both pictures stacked, the second one clipped at the handle. Works without scripts through the range input's own value in the browser, and with the website's small script. */
function Compare({ before, after }: { before: { url: string; label?: string }; after: { url: string; label?: string } }) {
  const L = useL();
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="sc-compare" ref={box} style={{ '--pos': '50%' } as CSSProperties} data-sc-compare>
      <Pic url={before.url} alt={before.label ?? L.before} className="sc-cmp-img" />
      <div className="sc-cmp-after"><Pic url={after.url} alt={after.label ?? L.after} className="sc-cmp-img" /></div>
      <span className="sc-cmp-tag l">{before.label ?? L.before}</span>
      <span className="sc-cmp-tag r">{after.label ?? L.after}</span>
      <span className="sc-cmp-handle" aria-hidden="true" />
      <input type="range" min={0} max={100} defaultValue={50} aria-label={L.compareHint} className="sc-cmp-range" data-sc-compare-range
        onInput={(e) => box.current?.style.setProperty('--pos', `${(e.target as HTMLInputElement).value}%`)} />
    </div>
  );
}

function Status({ s }: { s: CompatStatus }) {
  const L = useL();
  const text = { works: L.works, partial: L.partial, planned: L.planned, no: L.no }[s];
  return <span className={'sc-status ' + s}>{text}</span>;
}

// ---------------------------------------------------------------- blocks

function Block({ b }: { b: ShowcaseBlock }) {
  const ctx = useContext(Ctx);
  const L = useL();
  switch (b.type) {
    case 'hero': {
      const bg = b.image ?? null;
      return (
        <section className={'sc-block sc-hero' + (bg ? ' has-img' : '')}>
          {bg && <Pic url={bg} alt="" className="sc-hero-img" />}
          <div className="sc-hero-body">
            {b.badges && <div className="sc-badges">{b.badges.map((x, i) => <span key={i} className="sc-badge">{x}</span>)}</div>}
            <h1>{b.title}</h1>
            {b.tagline && <p>{b.tagline}</p>}
            {b.video && <div className="sc-hero-video"><Video url={b.video} poster={undefined} title={b.title} /></div>}
          </div>
        </section>
      );
    }
    case 'features':
      return (
        <section className="sc-block">
          <Title>{b.title}</Title>
          <div className="sc-features">
            {b.items.map((f, i) => {
              const I = ICONS[f.icon];
              return <div key={i} className="sc-feature"><span className="sc-ico">{I ? <I size={20} /> : null}</span><b>{f.title}</b><p>{f.text}</p></div>;
            })}
          </div>
        </section>
      );
    case 'gallery': {
      const urls = b.images.map((x) => x.url);
      return (
        <section className="sc-block">
          <Title>{b.title}</Title>
          <div className="sc-gallery">
            {b.images.map((im, i) => (
              <figure key={i}>
                {ctx.onZoom
                  ? <button type="button" className="sc-zoom" onClick={() => ctx.onZoom!(urls, i)} aria-label={im.alt ?? im.caption ?? ''}><Pic url={im.url} alt={im.alt ?? im.caption ?? ''} /></button>
                  : <Pic url={im.url} alt={im.alt ?? im.caption ?? ''} />}
                {im.caption && <figcaption>{im.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      );
    }
    case 'compare':
      return (
        <section className="sc-block">
          <Title>{b.title}</Title>
          <Compare before={b.before} after={b.after} />
          {b.caption && <p className="sc-caption">{b.caption}</p>}
        </section>
      );
    case 'video':
      return (
        <section className="sc-block">
          <Title>{b.title}</Title>
          <Video url={b.url} poster={b.poster} title={b.title} />
          {b.caption && <p className="sc-caption">{b.caption}</p>}
        </section>
      );
    case 'text':
      return <section className="sc-block"><Title>{b.title}</Title><Md source={b.markdown} /></section>;
    case 'compat':
      return (
        <section className="sc-block">
          <Title>{b.title ?? L.compat}</Title>
          <table className="sc-table">
            <thead><tr><th>{L.game}</th><th>{L.status}</th></tr></thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}><td>{ctx.gameName?.(r.game) ?? r.game}</td><td><Status s={r.status} />{r.note && <span className="sc-note">{r.note}</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    case 'hotkeys':
      return (
        <section className="sc-block">
          <Title>{b.title ?? L.hotkeys}</Title>
          <table className="sc-table">
            <thead><tr><th>{L.keyHeader}</th><th>{L.action}</th></tr></thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.keys.split('+').map((k, j) => <span key={j}>{j > 0 && <span className="sc-plus">+</span>}<kbd>{k.trim()}</kbd></span>)}</td>
                  <td>{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    case 'changelog': {
      const list = (ctx.releases ?? []).filter((r) => r.notes.trim()).slice(0, b.count ?? 1);
      if (!list.length) return null;
      return (
        <section className="sc-block">
          <Title>{b.title ?? L.changelog}</Title>
          {list.map((r, i) => (
            <div key={i} className="sc-release">
              <div className="sc-release-head"><span className="sc-badge">{r.version}</span>{r.date && <span className="sc-dim">{r.date.slice(0, 10)}</span>}</div>
              <Md source={r.notes.length > 1500 ? r.notes.slice(0, 1500) + ' ...' : r.notes} />
            </div>
          ))}
        </section>
      );
    }
    case 'faq':
      return (
        <section className="sc-block">
          <Title>{b.title ?? L.faq}</Title>
          <div className="sc-faq">
            {b.items.map((it, i) => (
              <details key={i}><summary>{it.q}</summary><div className="sc-md"><p><Inline nodes={parseInline(it.a)} /></p></div></details>
            ))}
          </div>
        </section>
      );
    case 'cta': {
      const buttons = b.buttons.flatMap((bt, i) => {
        const cls = 'sc-btn ' + (bt.style ?? (i === 0 ? 'primary' : 'ghost'));
        if (bt.kind === 'install') {
          if (ctx.onInstall) return [<button key={i} type="button" className={cls} onClick={ctx.onInstall}><Download size={16} /> {bt.label}</button>];
          if (ctx.installHref) return [<a key={i} className={cls} href={ctx.installHref}><Download size={16} /> {bt.label}</a>];
          return [];
        }
        const url = bt.url ?? (bt.kind === 'companion' ? ctx.companion?.url : undefined);
        return url ? [<A key={i} href={url} className={cls}><ExternalLink size={15} /> {bt.label}</A>] : [];
      });
      if (!buttons.length) return null;
      return (
        <section className="sc-block sc-cta">
          <Title>{b.title}</Title>
          {b.text && <p>{b.text}</p>}
          <div className="sc-cta-row">{buttons}</div>
        </section>
      );
    }
  }
}

/** The showcase: blocks in order, theme accent from the palette. */
/** scheme: pins light or dark for hosts that have no data-theme on the root (the portal is dark only); without it the host's theme decides. */
export function ShowcaseView({ showcase, ctx = {}, className = '', scheme }: { showcase: Showcase; ctx?: ShowcaseCtx; className?: string; scheme?: 'light' | 'dark' }) {
  return (
    <Ctx.Provider value={ctx}>
      <div className={('sc ' + className).trim()} data-accent={showcase.theme?.accent ?? 'blue'} data-scheme={scheme} data-testid="showcase">
        {showcase.blocks.map((b, i) => <Block key={i} b={b} />)}
      </div>
    </Ctx.Provider>
  );
}
