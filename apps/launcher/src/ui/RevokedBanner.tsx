// Startup warning when the TM Horizon Hub has revoked a version that is installed here (matched by
// the installed file's sha256). Remove = roll back that install (its backup puts back what it
// replaced and deletes what it added); without a backup the files have to go by hand.
import { useEffect, useState } from 'react';
import { ShieldAlert, Trash2, X } from 'lucide-react';
import { backend } from '../data/backend';
import { CATALOG } from '../data/hub';
import { onHubIndexChange, revokedInstalls, type RevokedInstall } from '../data/hubIndex';
import { useHubState } from '../state';
import { useT } from '../i18n';

export function RevokedBanner() {
  const hub = useHubState();
  const t = useT();
  const [list, setList] = useState<RevokedInstall[]>([]);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { void revokedInstalls().then(setList); };
  useEffect(() => { load(); return onHubIndexChange(load); }, []);
  if (hidden || list.length === 0) return null;
  const name = (id: string) => CATALOG.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="revoked-banner" role="alert">
      <ShieldAlert size={18} />
      <div className="grow">
        <b>{t('revoked.title', { n: list.length })}</b>
        {list.map((r) => (
          <div className="revoked-row small" key={r.record.entryId + '|' + r.record.game}>
            <span className="grow"><b>{name(r.record.entryId)} {r.version}</b> · {hub.game(r.record.game)?.short ?? r.record.game} · {r.reason}</span>
            {r.record.backupId && backend.modUpdates
              ? <button className="btn ghost sm" disabled={!!busy} onClick={async () => {
                  setBusy(r.record.entryId);
                  hub.toast(await backend.modUpdates!.rollback(r.record.entryId, r.record.game));
                  setBusy(null);
                  load();
                }}><Trash2 size={13} /> {t('revoked.remove')}</button>
              : <span className="dim" title={r.record.files.join('\n')}>{t('revoked.byHand')}</span>}
          </div>
        ))}
      </div>
      <button className="btn ghost sm" title={t('common.close')} onClick={() => setHidden(true)}><X size={16} /></button>
    </div>
  );
}
