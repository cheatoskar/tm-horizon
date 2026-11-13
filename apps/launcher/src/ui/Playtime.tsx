// Play time per game (and per separate installation), counted by the launcher while the game runs
// (also when it was started outside the launcher). Local only. Rust side: src-tauri/src/playtime.rs.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isNative } from '../data/backend';
import { useT } from '../i18n';

interface Entry { seconds: number; sessions: number; lastPlayed: number }
type Store = { games: Record<string, Entry> };

/** Play time of all games; refreshed every minute while shown. */
export function usePlaytime(): Store['games'] {
  const [games, setGames] = useState<Store['games']>({});
  useEffect(() => {
    if (!isNative) return;
    let dead = false;
    const load = () => invoke<Store>('playtime_all').then((s) => { if (!dead) setGames(s.games); }).catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(id); };
  }, []);
  return games;
}

/** Seconds of a game including its separate installations. */
export function gameSeconds(games: Store['games'], id: string): number {
  return Object.entries(games).filter(([k]) => k === id || k.startsWith(id + '@')).reduce((a, [, e]) => a + e.seconds, 0);
}

/** "12 h 30 min", "45 min", "under 1 min"; nothing played: "0 min" (never "under 1 min" for no time at all). */
export function useFormatTime() {
  const t = useT();
  return (s: number) => {
    if (!(s > 0)) return t('playtime.min', { m: 0 });
    const m = Math.floor(s / 60);
    if (m < 1) return t('playtime.underMin');
    return m < 60 ? t('playtime.min', { m }) : t('playtime.hm', { h: Math.floor(m / 60), m: m % 60 });
  };
}

/** Short form for big numbers: "1577 h" from 100 h on, otherwise like useFormatTime. */
export function useFormatTimeShort() {
  const t = useT();
  const full = useFormatTime();
  return (s: number) => (s >= 100 * 3600 ? t('playtime.h', { h: Math.round(s / 3600) }) : full(s));
}
