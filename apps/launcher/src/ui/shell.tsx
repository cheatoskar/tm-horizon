import { BarChart3, Bot, Copy, Images, Gamepad2, Home, LayoutGrid, Layers, Map as MapIcon, Minus, Newspaper, Palette, Puzzle, Server, Settings, Square, Users, WifiOff, X } from 'lucide-react';
import { UpdatePill } from './Updater';
import { useEffect, useState } from 'react';
import { go, useHubState } from '../state';
import { backend, isNative } from '../data/backend';
import { useT } from '../i18n';
import { toBody } from './Modal';
import { embeddedOpen } from './webLayer';
import { openSection, rememberSection } from '../data/navHistory';
import { resetModsView } from '../pages/Mods';

/** Width of a rail label (12.5px semibold + padding), measured once per text. */
const widths = new Map<string, number>();
function labelWidth(text: string): number {
  let w = widths.get(text);
  if (w === undefined) {
    const c = document.createElement('canvas').getContext('2d');
    if (c) c.font = '600 12.5px Inter Variable, Inter, system-ui, sans-serif';
    w = Math.ceil((c?.measureText(text).width ?? text.length * 7.5) + 22);
    widths.set(text, w);
  }
  return w;
}

const NAV = [
  { page: 'home', icon: Home, label: 'nav.home' },
  { page: 'news', icon: Newspaper, label: 'nav.news' },
  { page: 'library', icon: LayoutGrid, label: 'nav.library' },
  { page: 'mods', icon: Puzzle, label: 'nav.mods' },
  { page: 'maps', icon: MapIcon, label: 'nav.maps' },
  { page: 'skins', icon: Palette, label: 'nav.skins' },
  { page: 'media', icon: Images, label: 'nav.media' },
  { page: 'stats', icon: BarChart3, label: 'nav.stats' },
  { page: 'profiles', icon: Layers, label: 'nav.profiles' },
  { page: 'servers', icon: Server, label: 'nav.servers' },
  { page: 'community', icon: Users, label: 'nav.community' },
];

// TAS mode keeps every page; Home becomes the TAS tools page and Servers is left out (no joins).
const NAV_TAS = NAV.filter((n) => n.page !== 'servers').map((n) => (n.page === 'home' ? { page: 'home', icon: Bot, label: 'nav.tasHome' } : n));

/** Play / TAS switch in the title bar, next to the window buttons. */
function ModeSwitch() {
  const { mode, setMode } = useHubState();
  const t = useT();
  // A real switch: "Game" left, "TAS" right, the knob slides; Space/Enter or the arrow keys flip it.
  const tas = mode === 'tas';
  const flip = () => setMode(tas ? 'play' : 'tas');
  return (
    <div className={'mode-toggle' + (tas ? ' tas' : '')}>
      <button className={'mt-label' + (!tas ? ' on' : '')} tabIndex={-1} onClick={() => tas && setMode('play')} title={t('mode.playTip')}><Gamepad2 size={13} />{t('mode.game')}</button>
      <button role="switch" aria-checked={tas} aria-label={t('mode.label')} className="mt-track" title={tas ? t('mode.playTip') : t('mode.tasTip')} onClick={flip}
        onKeyDown={(e) => { if (e.key === 'ArrowRight' && !tas) { e.preventDefault(); setMode('tas'); } if (e.key === 'ArrowLeft' && tas) { e.preventDefault(); setMode('play'); } }}>
        <span className="mt-knob" />
      </button>
      <button className={'mt-label' + (tas ? ' on' : '')} tabIndex={-1} onClick={() => !tas && setMode('tas')} title={t('mode.tasTip')}><Bot size={13} />TAS</button>
    </div>
  );
}

export function TitleBar() {
  const t = useT();
  const { mode } = useHubState();
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!isNative) return;
    const check = () => setMax(window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  const win = (a: 'minimize' | 'toggle-maximize' | 'close') => backend.window?.(a);
  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={(e) => { if ((e.target as HTMLElement).hasAttribute('data-tauri-drag-region')) win('toggle-maximize'); }}>
      <div className="brand" data-tauri-drag-region><img className="brand-word dark" width="273" height="60" src="/brand/wordmark-dark.png" alt="TM Horizon" draggable={false} /><img className="brand-word light" width="273" height="60" src="/brand/wordmark-light.png" alt="" draggable={false} /></div>
      {mode === 'tas' && <span className="tas-badge" title={t('tas.offlineTip')}><WifiOff size={12} /> TAS · {t('mode.offline')}</span>}
      <div className="grow drag" data-tauri-drag-region />
      <UpdatePill />
      <ModeSwitch />
      <div className="winbtns">
        <button aria-label={t('nav.minimize')} onClick={() => win('minimize')}><Minus size={14} /></button>
        <button aria-label={max ? t('nav.restore') : t('nav.maximize')} onClick={() => win('toggle-maximize')}>{max ? <Copy size={11} style={{ transform: 'scaleX(-1)' }} /> : <Square size={11} />}</button>
        <button className="close" aria-label={t('common.close')} onClick={() => win('close')}><X size={15} /></button>
      </div>
    </header>
  );
}

export function Sidebar() {
  const { route, mode } = useHubState();
  const t = useT();
  const active = route.page === 'game' ? 'library' : route.page === 'tashome' ? 'home' : route.page === 'tas' ? 'maps' : route.page === 'clips' ? 'media' : route.page === 'map' ? 'maps' : route.page === 'skinlib' ? 'skins' : route.page;
  // The hover label floats at the app root (fixed position), so no page content can cover it.
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  // On pages with an embedded site the label would sit under that native view: it is drawn in a native
  // tooltip window instead (the page itself never moves).
  const show = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (embeddedOpen() && backend.web) {
      const th = document.documentElement.dataset.theme;
      const dark = th === 'dark' || (th !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      void backend.web.tipShow(label, r.right + 10, r.top + r.height / 2, labelWidth(label), dark).catch(() => undefined);
      return;
    }
    setTip({ label, x: r.right + 10, y: r.top + r.height / 2 });
  };
  const hide = () => { setTip(null); void backend.web?.tipHide().catch(() => undefined); };
  // Each section keeps its last route like a browser tab (navHistory.openSection).
  useEffect(() => { rememberSection(active, location.hash); }, [active, route.page, route.arg]);
  const open = (page: string) => openSection(page, active, () => { if (page === 'mods') resetModsView(); go(page); });
  const item = (page: string, Icon: typeof Home, label: string) => (
    <button key={page} className={'rail-btn' + (active === page ? ' on' : '')} onClick={() => { hide(); open(page); }} aria-label={t(label)}
      onMouseEnter={show(t(label))} onMouseLeave={hide} onFocus={show(t(label))} onBlur={hide}>
      <Icon size={21} strokeWidth={1.9} />
    </button>
  );
  return (
    <nav className="rail">
      {(mode === 'tas' ? NAV_TAS : NAV).map(({ page, icon, label }) => item(page, icon, label))}
      <div className="grow" />
      {item('settings', Settings, 'nav.settings')}
      {tip && toBody(<span className="rail-tip-float" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.label}</span>)}
    </nav>
  );
}
