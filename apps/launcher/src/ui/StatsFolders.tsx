// Settings > Statistics: extra replay folders per game family (moved Autosaves, old replay backups).
// Statistics reads them like the games' own Replays folders (stats.rs add_extra_replays); a folder that
// is not there right now is skipped and marked here.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, FolderPlus, Trash2 } from 'lucide-react';
import { useT } from '../i18n';
import { useHubState } from '../state';
import { isNative } from '../data/backend';
import { FAMILY_NAME } from '../data/statsView';

interface ExtraFolder { family: string; path: string; missing: boolean }

/** Statistics family of a game id (stats.rs family_of). */
const familyOf = (id: string) => (id === 'tmnf' || id === 'tmuf' ? 'forever' : id.startsWith('tm2-') || id === 'maniaplanet' ? 'maniaplanet' : id);

export function StatsFolders() {
  const t = useT();
  const hub = useHubState();
  const [list, setList] = useState<ExtraFolder[] | null>(null);
  useEffect(() => { if (isNative) invoke<ExtraFolder[]>('stats_extra_folders').then(setList).catch(() => setList([])); }, []);
  if (!isNative) return null;
  // Families of the installed games, plus any that already has folders.
  const shown = new Set(hub.games.filter((g) => g.installed).map((g) => familyOf(g.id)));
  const run = (p: Promise<ExtraFolder[]>) => p.then(setList).catch((e) => hub.toast({ ok: false, message: String(e) }));
  return (
    <section className="panel">
      <ul className="setlist stats-dirs">
        {Object.entries(FAMILY_NAME).filter(([fam]) => shown.has(fam) || (list ?? []).some((f) => f.family === fam)).map(([fam, name]) => {
          const mine = (list ?? []).filter((f) => f.family === fam);
          return (
            <li key={fam}>
              <div className="grow">
                <b>{name}</b>
                {mine.map((f) => (
                  <div key={f.path} className="stats-dir">
                    <span className="mono ellip small" title={f.path}>{f.path}</span>
                    {f.missing && <span className="small warn" title={t('statsdirs.missingTip')}><AlertTriangle size={12} /> {t('settings.missing')}</span>}
                    <button className="btn icon tiny" title={t('common.remove')} aria-label={t('common.remove')}
                      onClick={() => run(invoke('stats_extra_folder_remove', { family: fam, path: f.path }))}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
              <button className="btn ghost sm" title={t('statsdirs.addTip')} onClick={() => run(invoke('stats_extra_folder_add', { family: fam }))}><FolderPlus size={14} /> {t('statsdirs.add')}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
