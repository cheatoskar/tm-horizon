import { FileSearch } from 'lucide-react';
import { useT } from '../i18n';
import { inspectMap, type InspectTarget } from './mapInspect';

/** Small "Inspect" button for map rows (Statistics, map lists): opens Map details. */
export function InspectButton({ target, label = false }: { target: InspectTarget; label?: boolean }) {
  const t = useT();
  return (
    <button className={label ? 'btn ghost sm' : 'btn icon tiny md-inspect'} title={t('mapinfo.inspectTip')} aria-label={t('mapinfo.inspect')}
      onClick={(e) => { e.stopPropagation(); inspectMap(target); }}>
      <FileSearch size={label ? 14 : 13} />{label && <> {t('mapinfo.inspect')}</>}
    </button>
  );
}
