// Settings > Linux (only shown on Linux): how the Windows games run (Wine, umu-run, Proton),
// which Wine prefix holds Documents and TMLoader, per-game runner and prefix, extra prefixes.
// Backend: src-tauri/src/linuxcmds.rs and platform/wine.rs.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderPlus, Trash2, Wine } from 'lucide-react';
import { isNative } from '../data/backend';
import { useHubState } from '../state';
import { useI18n } from '../i18n';
import { LinuxSetupSection } from './LinuxGameSetup';

interface LinuxGame { runner?: string | null; proton?: string | null; prefix?: string | null }
interface LinuxSettings { runner: string; wine?: string | null; proton?: string | null; prefix?: string | null; prefixes: string[]; games: Record<string, LinuxGame> }
interface PrefixInfo { path: string; source: string; steamAppId: number | null; documents: string | null; tmloader: boolean }
interface LinuxInfo { platform: string; prefixes: PrefixInfo[]; mainPrefix: string | null; wine: string | null; umu: string | null; protons: string[]; settings: LinuxSettings }

const GAMES = ['tmnf', 'tmuf', 'tmn-eswc', 'maniaplanet', 'tm2020'];
const RUNNERS = ['auto', 'wine', 'umu', 'proton'];

export function LinuxPanel() {
  const hub = useHubState();
  const { t } = useI18n();
  const [info, setInfo] = useState<LinuxInfo | null>(null);
  const [extra, setExtra] = useState('');

  useEffect(() => { if (isNative) invoke<LinuxInfo>('linux_info').then(setInfo).catch(() => {}); }, []);
  if (!info || info.platform !== 'linux') return null;
  const s = info.settings;

  const save = async (next: LinuxSettings) => {
    try {
      setInfo(await invoke<LinuxInfo>('linux_save', { settings: next }));
      hub.toast({ message: t('linux.saved') });
    } catch (e) { hub.toast({ message: String(e), ok: false }); }
  };
  const setGame = (id: string, patch: LinuxGame) => save({ ...s, games: { ...s.games, [id]: { ...s.games[id], ...patch } } });
  const runnerLabel = (r: string) => {
    const missing = (r === 'wine' && !info.wine) || (r === 'umu' && !info.umu) || (r === 'proton' && !info.protons.length);
    return t(`linux.${r}`) + (missing ? ` (${t('linux.notFound')})` : '');
  };
  const prefixOptions = info.prefixes.map((p) => <option key={p.path} value={p.path}>{p.path} · {p.source}</option>);

  return (
    <div className="settings-block">
      <h2>{t('linux.title')}</h2>
      <LinuxSetupSection />
      <section className="panel">
        <div className="setrow">
          <Wine size={18} />
          <div className="grow"><b>{t('linux.runner')}</b><div className="dim small setnote">{t('linux.runnerNote')}</div></div>
          <select className="text-in" value={s.runner || 'auto'} aria-label={t('linux.runner')} onChange={(e) => save({ ...s, runner: e.target.value })}>
            {RUNNERS.map((r) => <option key={r} value={r}>{runnerLabel(r)}</option>)}
          </select>
        </div>
        {info.protons.length > 0 && (
          <div className="setrow">
            <div className="grow"><b>{t('linux.protonPath')}</b></div>
            <select className="text-in" value={s.proton ?? ''} aria-label={t('linux.protonPath')} onChange={(e) => save({ ...s, proton: e.target.value || null })}>
              <option value="">{t('linux.newest')}</option>
              {info.protons.map((p) => <option key={p} value={p}>{p.split('/').pop()}</option>)}
            </select>
          </div>
        )}
        <div className="setrow">
          <div className="grow">
            <b>{t('linux.prefix')}</b>
            <div className="dim small setnote">{t('linux.prefixNote')}{!s.prefix && info.mainPrefix ? ' ' + t('linux.prefixAuto', { path: info.mainPrefix }) : ''}</div>
          </div>
          <select className="text-in" value={s.prefix ?? ''} aria-label={t('linux.prefix')} onChange={(e) => save({ ...s, prefix: e.target.value || null })}>
            <option value="">{t('linux.auto')}</option>
            {prefixOptions}
          </select>
        </div>
      </section>

      <section className="panel">
        <b>{t('linux.games')}</b>
        {GAMES.map((id) => {
          const g = s.games[id] ?? {};
          return (
            <div className="setrow" key={id}>
              <div className="grow">{hub.game(id)?.name ?? id}</div>
              <select className="text-in" value={g.runner ?? ''} aria-label={t('linux.runner')} onChange={(e) => setGame(id, { runner: e.target.value || null })}>
                <option value="">{t('linux.default')}</option>
                {RUNNERS.filter((r) => r !== 'auto').map((r) => <option key={r} value={r}>{runnerLabel(r)}</option>)}
              </select>
              <select className="text-in" value={g.prefix ?? ''} aria-label={t('linux.gamePrefix')} onChange={(e) => setGame(id, { prefix: e.target.value || null })}>
                <option value="">{t('linux.default')}</option>
                {prefixOptions}
              </select>
            </div>
          );
        })}
      </section>

      <section className="panel">
        <b>{t('linux.prefixes')}</b>
        {info.prefixes.length === 0 && <p className="dim small">{t('linux.none')}</p>}
        <ul className="setlist">
          {info.prefixes.map((p) => (
            <li key={p.path}>
              <span className="mono ellip" title={p.path}>{p.path}</span>
              <span className="dim small">{p.source}{p.steamAppId ? ` ${p.steamAppId}` : ''}{p.tmloader ? ' · TMLoader' : ''}</span>
              {s.prefixes.includes(p.path) && (
                <button className="btn icon tiny" title={t('common.remove')} onClick={() => save({ ...s, prefixes: s.prefixes.filter((x) => x !== p.path) })}><Trash2 size={13} /></button>
              )}
            </li>
          ))}
        </ul>
        <div className="row-btns">
          <input className="text-in grow mono" value={extra} placeholder="/home/me/Games/tmnf" aria-label={t('linux.addPrefix')} onChange={(e) => setExtra(e.target.value)} />
          <button className="btn ghost sm" disabled={!extra.trim()} onClick={() => { save({ ...s, prefixes: [...s.prefixes, extra.trim()] }); setExtra(''); }}><FolderPlus size={14} /> {t('linux.add')}</button>
        </div>
      </section>
    </div>
  );
}
