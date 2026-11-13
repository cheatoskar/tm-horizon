// Project type: the icon (glyphs from packages/shared/src/modicon.ts), the picker used by the form and the
// import preview, and what the choice means for players (plain words, one sentence).
import {
  BookOpen, Braces, CalendarDays, Globe, Layers, Map as MapIcon, Package, PaintBucket, PencilRuler, PlugZap, Puzzle, Server, Timer, Users, Volume2, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { HUB_PROJECT_TYPES, PROJECT_TYPES, type DownloadBreakdown, type HubProjectType } from '@tm-hub/shared';
import { PROJECT_TYPE_ICONS } from '@tm-hub/shared/modicon';
import { RadioCards, InfoTip } from './controls.tsx';

const GLYPHS: Record<string, LucideIcon> = {
  puzzle: Puzzle, 'paint-bucket': PaintBucket, layers: Layers, 'volume-2': Volume2, map: MapIcon, 'plug-zap': PlugZap, braces: Braces, wrench: Wrench,
  timer: Timer, 'pencil-ruler': PencilRuler, server: Server, package: Package, globe: Globe, 'book-open': BookOpen, users: Users, 'calendar-days': CalendarDays,
};

export function TypeIcon({ type, size = 16 }: { type: HubProjectType; size?: number }) {
  const G = GLYPHS[PROJECT_TYPE_ICONS[type] ?? 'puzzle'] ?? Puzzle;
  return <G size={size} aria-hidden />;
}

export const typeLabel = (t: HubProjectType | null | undefined) => (t ? PROJECT_TYPES[t].label : 'Type not set');

/** What players get, by delivery (shown under the picker). */
export function deliveryText(t: HubProjectType): string {
  switch (PROJECT_TYPES[t].delivery) {
    case 'game': return 'The launcher installs the files of each version into the game you pick below.';
    case 'files': return 'The launcher installs it when a version has an install type; otherwise players download it.';
    case 'browser': return 'Never installed into a game. The launcher links to your store pages and offers the zip in its browser add-on list. Add store links under Related links.';
    case 'link': return 'No files. The launcher shows the page and opens your links.';
  }
}

export function TypePicker({ value, onChange, name = 'ptype' }: { value: HubProjectType | null; onChange: (t: HubProjectType) => void; name?: string }) {
  return (
    <>
      <RadioCards<HubProjectType> name={name} value={value} onChange={onChange} columns={3} ariaLabel="Project type"
        options={HUB_PROJECT_TYPES.map((t) => ({ value: t, label: PROJECT_TYPES[t].label, hint: PROJECT_TYPES[t].hint, icon: <TypeIcon type={t} size={18} /> }))} />
      {value && <p className="hint" style={{ marginTop: 'var(--tm-s-2)', marginBottom: 0 }}>{deliveryText(value)}</p>}
    </>
  );
}

export const fmtCount = (n: number) => n.toLocaleString('en-US');

/** "1,234 downloads" with a tooltip that says where the number comes from. */
export function downloadsTip(d: DownloadBreakdown) {
  const nc = d.notCounted.map((s) => (s === 'tmloader' ? 'TMLoader server' : 'Discord'));
  return (
    <span>
      TM Horizon {fmtCount(d.hub)}{d.github !== null ? <> · GitHub {fmtCount(d.github)}</> : null}
      {nc.length > 0 && <><br />{nc.join(' and ')}: not counted (no numbers there)</>}
      <br />TM Horizon counts each installation once a day per project. No personal data is stored.
    </span>
  );
}

export function Downloads({ d }: { d: DownloadBreakdown }) {
  return (
    <span className="dl-total">
      <b>{fmtCount(d.total)}</b> <span className="muted">total downloads</span> <InfoTip text={downloadsTip(d)} />
    </span>
  );
}
