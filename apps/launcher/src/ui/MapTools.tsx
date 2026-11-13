import { FileSearch, ListTree, Search, Wrench } from 'lucide-react';
import { backend } from '../data/backend';
import { SITES, type Site } from '../data/sites';
import { Modal } from './Modal';
import { useT } from '../i18n';
import { inspectMap } from './mapInspect';

/** Map tools: Map details (the map inspector, natively: pages/MapDetails.tsx) for a picked .Gbx or the local
 * maps, plus the GBX.NET web tools in the embedded browser. The 100tmx.com inspector page is no longer offered
 * here: the same inspector runs inside the launcher now. */
export function MapTools({ onClose, onOpen, game }: { onClose: () => void; onOpen: (game: string, s: Site) => void; game: string }) {
  const t = useT();
  const tools = SITES.filter((s) => s.kind === 'tools' && s.host !== '100tmx.com');
  const open = (s: Site) => onOpen(s.games.includes(game) ? game : s.games[0], s);
  const pick = async () => {
    const path = await backend.gbxPick?.();
    if (!path) return;
    onClose();
    inspectMap({ path });
  };
  return (
    <Modal title={<><Wrench size={16} /> {t('maptools.title')}</>} onClose={onClose} actions={<button className="btn ghost" onClick={onClose}>{t('common.close')}</button>}>
      <b>{t('mapinfo.title')}</b>
      <p className="dim small">{t('maptools.detailsNote')}</p>
      <div className="mt-sites">
        {backend.gbxPick && <button className="btn primary" onClick={() => void pick()}><FileSearch size={14} /> {t('mapinfo.open')}</button>}
        <button className="btn ghost" onClick={() => { onClose(); inspectMap(); }}><ListTree size={14} /> {t('mapinfo.localMaps')}</button>
      </div>
      {tools.length > 0 && (
        <>
          <b>{t('maptools.gbxTools')}</b>
          <div className="mt-sites">
            {tools.map((s) => (
              <button key={s.host} className="btn ghost" onClick={() => open(s)} title={s.host}>
                <Search size={14} /> {s.label}
                <span className="dim small">{s.host}</span>
              </button>
            ))}
          </div>
          <p className="dim small">{t('maptools.sitesNote')}</p>
        </>
      )}
    </Modal>
  );
}
