import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'tmhub-theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

/** Saves the choice and applies it to the document. */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* storage blocked */ }
  applyThemePref(pref);
  listeners.forEach((l) => l());
}

export function applyThemePref(pref: ThemePref = getThemePref()): void {
  const el = document.documentElement;
  if (pref === 'system') delete el.dataset.theme; else el.dataset.theme = pref;
}

const listeners = new Set<() => void>();
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  mq?.addEventListener('change', cb);
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => { listeners.delete(cb); mq?.removeEventListener('change', cb); obs.disconnect(); };
}

function snapshot(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return mq?.matches ? 'light' : 'dark';
}

/** The scheme in effect right now: the data-theme override, else the system setting. */
export function useScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, snapshot, () => 'dark');
}

/** The saved choice (system, light or dark), live. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, getThemePref, () => 'system');
}
