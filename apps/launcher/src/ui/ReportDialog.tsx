// "Report a problem": the backend collects logs, crash logs and a system summary (redacted),
// this dialog shows the file list and a preview; the zip goes to the Desktop or Downloads.
// Nothing is uploaded. Per mod there is a link to the author's report page.
import { useEffect, useMemo, useState } from 'react';
import { Bug, ExternalLink, FileText, FolderOpen, Loader2 } from 'lucide-react';
import { backend, type Report } from '../data/backend';
import { reportPage } from '../data/hub';
import { fmtSize } from '../data/model';
import { tmlName, useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';

export function ReportDialog({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const g = hub.game(gameId);
  const profile = hub.profileFor(gameId);
  const pname = g.family === 'forever' ? tmlName(profile) : null;
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<string>('summary');
  const [target, setTarget] = useState<'desktop' | 'downloads'>('desktop');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    backend.report?.collect(gameId, g.name, pname)
      .then((r) => { setRep(r); setSel(new Set(r.files.filter((f) => f.include).map((f) => f.id))); })
      .catch((e) => setError(String(e)));
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mods = useMemo(() => (profile?.mods ?? []).map((m) => {
    const mv = hub.mods.find((x) => x.id === m.id);
    return { id: m.id, name: mv?.name ?? m.id, page: reportPage(m.id, mv?.homepage ?? null) };
  }), [profile, hub.mods]);

  const file = rep?.files.find((f) => f.id === shown);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    if (!backend.report) return;
    setSaving(true);
    try {
      const path = await backend.report.save(gameId, g.name, pname, [...sel], target);
      hub.toast({ message: t('report.saved', { path }), actions: [{ label: t('common.show'), run: () => backend.reveal?.(path) }] });
      onClose();
    } catch (e) { hub.toast({ message: String(e), ok: false }); }
    setSaving(false);
  };

  return (
    <Modal wide title={<><Bug size={18} /> {t('report.title', { game: g.short })}</>} onClose={onClose}
      actions={<>
        <label className="select"><span className="dim small">{t('report.saveTo')}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
            <option value="desktop">{t('report.desktop')}</option>
            <option value="downloads">{t('report.downloads')}</option>
          </select>
        </label>
        <div className="grow" />
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!rep || saving} onClick={save}>{saving ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />} {t('report.save')}</button>
      </>}>
      <p className="dim small">{t('report.intro')}</p>
      {error && <p className="warn small">{error}</p>}
      {!rep && !error && <p className="dim"><Loader2 size={15} className="spin" /> {t('report.collecting')}</p>}
      {rep && (
        <div className="report-grid">
          <ul className="report-files">
            <li className={shown === 'summary' ? 'on' : ''} onClick={() => setShown('summary')}>
              <input type="checkbox" checked readOnly disabled />
              <FileText size={14} /><span className="grow ellip">summary.txt</span><span className="dim small">{t('report.system')}</span>
            </li>
            {rep.files.map((f) => (
              <li key={f.id} className={shown === f.id ? 'on' : ''} onClick={() => setShown(f.id)} title={f.path}>
                <input type="checkbox" checked={sel.has(f.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(f.id)} />
                <FileText size={14} /><span className="grow ellip" title={f.id}>{f.id}</span>
                <span className="dim small nowrap">{f.binary ? t('report.binary') : fmtSize(f.size)}</span>
              </li>
            ))}
            {rep.files.length === 0 && <li className="dim small">{t('report.noLogs')}</li>}
          </ul>
          <pre className="report-preview">{shown === 'summary' ? rep.summary : file?.binary ? t('report.binaryNote') : file?.preview}</pre>
        </div>
      )}
      {mods.length > 0 && (
        <div className="report-mods">
          <b className="small">{t('report.authors')}</b>
          <div className="row-btns">
            {mods.map((m) => m.page
              ? <button key={m.id} className="btn ghost sm" title={m.page} onClick={() => backend.openExternal(m.page!)}><ExternalLink size={13} /> {m.name}</button>
              : <span key={m.id} className="pill tiny muted" title={t('report.noPage')}>{m.name}</span>)}
          </div>
        </div>
      )}
    </Modal>
  );
}
