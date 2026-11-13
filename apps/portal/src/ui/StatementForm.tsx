import { useState, type ReactNode } from 'react';
import type { StatementInput } from '../api.ts';
import { GROUNDS } from '../labels.ts';
import { Field, Modal, Notice, useAction } from './common.tsx';
import { Checkbox } from './controls.tsx';

/** Statement of reasons (DSA Art. 17) as a modal form. */
export function StatementModal({ title, submitLabel, extra, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  extra?: (state: { value: boolean; set: (v: boolean) => void }) => ReactNode;
  onSubmit: (s: StatementInput, extraValue: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const [facts, setFacts] = useState('');
  const [preset, setPreset] = useState(GROUNDS[0]!);
  const [custom, setCustom] = useState('');
  const [groundType, setGroundType] = useState<'terms' | 'law'>('terms');
  const [automated, setAutomated] = useState(false);
  const [ex, setEx] = useState(false);
  const { busy, error, run } = useAction();
  const ground = preset === '__custom' ? custom.trim() : preset;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await onSubmit({ facts: facts.trim(), ground, groundType, automated }, ex); onClose(); }); }}>
        {error && <Notice tone="err">{error}</Notice>}
        <Field label="Facts" hint="What happened and what the decision is based on. The author sees this text.">
          <textarea required minLength={10} maxLength={4000} value={facts} onChange={(e) => setFacts(e.target.value)} />
        </Field>
        <Field label="Ground">
          <select value={preset} onChange={(e) => { setPreset(e.target.value); if (e.target.value === '__custom') setGroundType('law'); }}>
            {GROUNDS.map((g) => <option key={g} value={g}>{g}</option>)}
            <option value="__custom">Other (write it)</option>
          </select>
        </Field>
        {preset === '__custom' && <Field label="Ground (text)"><input required minLength={3} maxLength={300} value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>}
        <Field label="Ground is">
          <select value={groundType} onChange={(e) => setGroundType(e.target.value as 'terms' | 'law')}>
            <option value="terms">The terms of use</option><option value="law">A law</option>
          </select>
        </Field>
        <div className="field"><Checkbox checked={automated} onChange={setAutomated} label="Detected or decided by automated means" /></div>
        {extra?.({ value: ex, set: setEx })}
        <div className="row" style={{ marginTop: 'var(--tm-s-4)' }}><button className="btn danger" disabled={busy || facts.trim().length < 10 || ground.length < 3}>{busy ? 'Saving' : submitLabel}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}
