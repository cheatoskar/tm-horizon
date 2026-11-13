// Which install folder of a game Play starts. One choice per game, kept by the launcher: the
// Horizon Host card, the install panel and the Play button all use it.
import { useEffect, useState } from 'react';
import { backend, isNative } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import type { InstallInfo, Snapshot } from '../data/types';

/** Installs the native side lists for a game (the games with several installs). */
export function installsOf(snap: Snapshot, game: string): InstallInfo[] {
  const g = snap.games as Record<string, { installs?: InstallInfo[] } | undefined>;
  return ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise', 'tm2020', 'tm-turbo'].includes(game) ? g[game]?.installs ?? [] : [];
}

/** The picked folder, if it is still one of `dirs`; else the first. */
export function useSelectedInstall(game: string, dirs: string[]): [string, (dir: string) => void] {
  const [n, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((x) => x + 1);
    window.addEventListener('tmh-selected-install', f);
    return () => window.removeEventListener('tmh-selected-install', f);
  }, []);
  void n;
  const saved = backend.info?.().settings.selectedInstall?.[game];
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();
  const cur = dirs.find((d) => saved && norm(d) === norm(saved)) ?? dirs[0] ?? '';
  const set = (dir: string) => { void backend.setSelectedInstall?.(game, dir).catch(() => undefined); };
  return [cur, set];
}

export function InstallPicker({ game }: { game: string }) {
  const hub = useHubState();
  const t = useT();
  const list = installsOf(hub.snapshot, game);
  const [cur, set] = useSelectedInstall(game, list.map((i) => i.path));
  if (!isNative || list.length < 2) return null;
  return (
    <label className="select hh-folder">
      <span className="dim small" title={t('install.pickTip')}>{t('install.pick')}</span>
      <select value={cur} onChange={(e) => set(e.target.value)} title={cur}>
        {list.map((i) => <option key={i.path} value={i.path}>{i.path}{i.source ? ` · ${i.source}` : ''}</option>)}
      </select>
    </label>
  );
}
