// Default icon of a mod without its own logo: the same generated tile as the website (apps/web
// components/Thumb.astro), from the shared mapping in packages/shared/src/modicon.ts: colour pair by the
// mod id, speed stripes, and a Lucide glyph for its type or category.
import {
  type LucideIcon, BookOpen, Bot, Box, Boxes, CalendarDays, Car, Flag, Gauge, Glasses, Layers, LayoutDashboard, Map, Medal, Music, Package,
  Mountain, PaintBucket, Palette, PencilRuler, PlugZap, Puzzle, Radio, Server, Timer, Trophy, Users, Volume2, Wrench,
} from 'lucide-react';
import { CATALOG_CAT_ICONS, MOD_CAT_ICONS, entryModType, iconAngle, iconHash, iconPair, modTypeIcon } from '@tm-hub/shared/modicon';

const GLYPHS: Record<string, LucideIcon> = {
  'book-open': BookOpen, box: Box, boxes: Boxes, 'calendar-days': CalendarDays, car: Car, flag: Flag, gauge: Gauge, glasses: Glasses,
  layers: Layers, 'layout-dashboard': LayoutDashboard, map: Map, medal: Medal, music: Music, package: Package, 'paint-bucket': PaintBucket,
  palette: Palette, 'pencil-ruler': PencilRuler, puzzle: Puzzle, radio: Radio, server: Server, timer: Timer, trophy: Trophy, users: Users,
  'volume-2': Volume2, wrench: Wrench, bot: Bot, mountain: Mountain, 'plug-zap': PlugZap,
};

/** Launcher categories of TMLoader mods (data/catalog.ts MOD_CATEGORIES) -> the hub categories the website uses. */
const LAUNCHER_CAT: Record<string, string> = {
  Graphics: 'graphics', Video: 'graphics', HUD: 'HUD', Tools: 'tools', TAS: 'TAS', Editor: 'editor', Competitive: 'competition',
  Fixes: 'tools', VR: 'VR', Library: 'library', Game: 'library', Community: 'gameplay',
};

/** Glyph of a TMLoader mod: the hub category (as on the website), else the first launcher category. */
export function glyphForMod(hubCategory: string | null | undefined, categories: string[] = []): string {
  const c = hubCategory ?? LAUNCHER_CAT[categories[0] ?? ''];
  return (c && MOD_CAT_ICONS[c]) || 'puzzle';
}
/** Glyph of a catalog entry: its mod type for mods, else its catalog category. */
export function glyphForEntry(e: { id: string; category: string; modType?: string | null }): string {
  return e.category === 'mod' || e.modType ? modTypeIcon(entryModType(e)) : CATALOG_CAT_ICONS[e.category] ?? 'puzzle';
}

export function GenIcon({ seed, glyph, size = 88, className = '' }: { seed: string; glyph: string; size?: number; className?: string }) {
  const [a, b] = iconPair(seed);
  const gid = 'gi' + iconHash(seed).toString(36);
  const G = GLYPHS[glyph] ?? Puzzle;
  return (
    <span className={'mod-icon gen-icon ' + className} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 96 96" width={size} height={size}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient>
          <linearGradient id={gid + 's'} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity=".22" /></linearGradient>
        </defs>
        <rect width="96" height="96" fill={`url(#${gid})`} />
        <g transform={`rotate(-${iconAngle(seed)} 48 48)`} fill={`url(#${gid}s)`}>
          <rect x="-30" y="14" width="120" height="5" rx="2.5" /><rect x="-10" y="26" width="90" height="3" rx="1.5" /><rect x="10" y="70" width="110" height="4" rx="2" /><rect x="-20" y="80" width="70" height="2.5" rx="1.25" />
        </g>
        <circle cx="78" cy="16" r="26" fill="#fff" opacity=".08" />
        <G x={26} y={26} width={44} height={44} color="#fff" strokeWidth={1.7} style={{ filter: 'drop-shadow(0 1.5px 1.5px rgba(0,0,0,.25))' }} />
      </svg>
    </span>
  );
}
