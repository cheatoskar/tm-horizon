// Horizon module icons (public/module-icons/<set>/<plugin id>.png, our own artwork): "distinct" (coloured
// badges, easier to tell apart; default since 0.5.0) or "saturn" (the TM Horizon planet behind each module's
// symbol). The choice is a per-PC look preference kept in localStorage; only a stored "saturn" keeps Saturn.
import { useSyncExternalStore } from 'react';

export type ModuleIconSet = 'saturn' | 'distinct';
const KEY = 'tmhub.moduleIcons';
const KNOWN = new Set(['clock', 'controller-hotplug', 'eswc-autosave', 'horizon-client', 'input-display', 'map-info', 'node-explorer', 'performance', 'race-reader', 'scripts', 'tmx-browser', 'tmx-upload', 'wr-hunter']);
const listeners = new Set<() => void>();

function read(): ModuleIconSet {
  try { return localStorage.getItem(KEY) === 'saturn' ? 'saturn' : 'distinct'; } catch { return 'distinct'; }
}

let current: ModuleIconSet = read();

export function setModuleIconSet(s: ModuleIconSet) {
  current = s;
  try { localStorage.setItem(KEY, s); } catch { /* no storage: this session only */ }
  listeners.forEach((f) => f());
}

export function useModuleIconSet(): ModuleIconSet {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => current);
}

/** Our icon for a module id ("autosave" ids map to eswc-autosave), or null for modules we have none for. */
export function moduleIconUrl(id: string, set: ModuleIconSet): string | null {
  const k = id.startsWith('eswc-autosave') || id === 'autosave' ? 'eswc-autosave' : id;
  return KNOWN.has(k) ? `/module-icons/${set}/${k}.png` : null;
}
