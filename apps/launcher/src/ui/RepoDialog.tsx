import { useState, type ReactNode } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { REPO, issueDraft, issueFormUrl, type IssueFields, type IssueKind } from '@tm-hub/shared';
import { backend } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';

/** Opens the issue form on GitHub, or (while the repository is not public) a dialog with the prepared text. */
/** `hint`: one extra line in the dialog (e.g. that a hub login sends it directly). */
export function useIssueForm(kind: IssueKind, fields: () => IssueFields, hint?: ReactNode) {
  const [open, setOpen] = useState(false);
  const start = () => { if (REPO.public) backend.openExternal(issueFormUrl(kind, fields())); else setOpen(true); };
  const dialog = open ? <RepoDialog kind={kind} fields={fields()} hint={hint} onClose={() => setOpen(false)} /> : null;
  return { start, dialog };
}

export function RepoDialog({ kind, fields, hint, onClose }: { kind: IssueKind; fields: IssueFields; hint?: ReactNode; onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const d = issueDraft(kind, fields);
  const [title, setTitle] = useState(d.title);
  const [body, setBody] = useState(d.body);
  const copy = () => { navigator.clipboard?.writeText(`${title}\n\n${body}`).then(() => hub.toast({ message: t('common.copied') })).catch(() => {}); };
  return (
    <Modal wide title={t('repo.title.' + kind)} onClose={onClose} actions={<>
      <span className="dim small grow">{t('repo.after')}</span>
      <button className="btn ghost" disabled title={t('repo.after')}><ExternalLink size={15} /> {t('repo.open')}</button>
      <button className="btn primary" onClick={copy}><Copy size={15} /> {t('repo.copy')}</button>
    </>}>
      <p className="dim small">{t('repo.intro')}</p>
      {hint}
      <label className="small dim">{t('repo.titleLabel')}</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <label className="small dim">{t('repo.bodyLabel')}</label>
      <textarea className="input mono small" value={body} rows={12} onChange={(e) => setBody(e.target.value)} style={{ width: '100%', resize: 'vertical' }} />
    </Modal>
  );
}
