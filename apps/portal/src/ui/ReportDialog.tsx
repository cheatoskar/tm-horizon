import { useState } from 'react';
import { REPORT_REASONS, type ReportReason } from '@tm-hub/shared';
import { api } from '../api.ts';
import { REASON_LABELS } from '../labels.ts';
import { Field, Modal, Notice, useAction } from './common.tsx';
import { Checkbox } from './controls.tsx';

/** "Inhalt melden" notice form (DSA Art. 16). */
export function ReportDialog({ slug, versionId, versionLabel, onClose }: { slug: string; versionId?: string; versionLabel?: string; onClose: () => void }) {
  const base = `${location.origin}/p/${slug}`;
  const [reason, setReason] = useState<ReportReason>('malware');
  const [explanation, setExplanation] = useState('');
  const [location_, setLocation] = useState(versionLabel ? `${base} (version ${versionLabel})` : base);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [good, setGood] = useState(false);
  const [website, setWebsite] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  if (done) {
    return (
      <Modal title="Received" onClose={onClose}>
        <Notice tone="ok">Your report was received. Report id: <b className="mono">{done}</b></Notice>
        <p className="muted small">Keep the id. If you gave an e-mail address, we answer there once it is decided.</p>
        <button className="btn" onClick={onClose}>Close</button>
      </Modal>
    );
  }
  return (
    <Modal title="Inhalt melden / Report content" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await api.report({
            projectSlug: slug, versionId: versionId ?? null, reason, explanation: explanation.trim(), location: location_.trim(),
            name: name.trim() || null, email: email.trim() || null, goodFaith: true, website,
          });
          setDone(r.id);
        });
      }}>
        {error && <div className="msg err" role="alert">{error}</div>}
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
          </select>
        </Field>
        <Field label="Explanation" hint="Why is this content illegal or against the terms? At least 20 characters.">
          <textarea required minLength={20} maxLength={5000} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
        </Field>
        <Field label="Location" hint="Where exactly the content is.">
          <input required maxLength={400} value={location_} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <div className="cols2">
          <Field label="Your name (optional)"><input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          <Field label="Your e-mail (optional)"><input type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        </div>
        <p className="hint" style={{ marginTop: 'calc(var(--tm-s-1) * -1)' }}>Name and e-mail are needed only if you want a reply.</p>
        <div className="hp" aria-hidden="true">
          <label>Website<input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
        </div>
        <div className="field">
          <Checkbox checked={good} onChange={setGood} label="Ich bestätige in gutem Glauben, dass die Angaben richtig und vollständig sind." hint="I confirm in good faith that the information is accurate and complete." />
        </div>
        <div className="row" style={{ marginTop: 'var(--tm-s-4)' }}><button className="btn primary" disabled={busy || !good || explanation.trim().length < 20}>{busy ? 'Sending' : 'Send report'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}
