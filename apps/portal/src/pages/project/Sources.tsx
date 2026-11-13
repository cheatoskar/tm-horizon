import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HubProject, HubSource } from '@tm-hub/shared';
import { api } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { Badge, Field, Notice, useAction } from '../../ui/common.tsx';
import { EmptyState, RadioCards, Section } from '../../ui/controls.tsx';
import { GitBranch } from 'lucide-react';
import { fmtDate } from '../../labels.ts';

function SourceCard({ s, canEdit, reload, browser = false, slug = '' }: { s: HubSource; canEdit: boolean; reload: () => void; browser?: boolean; slug?: string }) {
  const { busy, error, run } = useAction();
  const [asset, setAsset] = useState(s.needsChoice?.assets[0] ?? '');
  const [info, setInfo] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="row">
        <b className="wrapword">{s.target}</b>
        <Badge tone="info">{s.kind === 'github' ? 'GitHub' : 'TMLoader'}</Badge>
        {s.product && <span className="muted small">{s.product}</span>}
        {s.webhook && <Badge tone="ok" title="The GitHub App tells the hub about new releases right away.">instant</Badge>}
      </div>
      <table style={{ marginTop: 'var(--tm-s-2)' }}><tbody>
        <tr><th>Last check</th><td>{fmtDate(s.lastCheck)}</td></tr>
        <tr><th>Next check</th><td>{fmtDate(s.nextCheck)}</td></tr>
        <tr><th>Imported</th><td>{s.imported} releases</td></tr>
      </tbody></table>
      <div style={{ marginTop: 'var(--tm-s-3)' }}>
        {s.setupNeeded && (
          <div className="msg warn"><div className="row">
            <span><b>Setup needed.</b> {s.setupReason ?? 'Choose the games and how it installs; then the releases come in.'}</span>
            {canEdit && slug && <Link className="btn sm primary right" to={`/projects/${slug}?tab=import`}>Set up</Link>}
          </div></div>
        )}
        {s.lastError && !s.setupNeeded && <Notice tone="err">{s.lastError}</Notice>}
        {error && <Notice tone="err">{error}</Notice>}
        {info && <Notice tone="ok">{info}</Notice>}
      </div>
      {s.needsChoice && (
        <div className="field" style={{ marginTop: 'var(--tm-s-2)' }}>
          <span className="lbl" id={`asset-lbl-${s.id}`}>Release {s.needsChoice.tag} has several files</span>
          <span className="hint">Pick the one to install. The hub remembers it for later releases.</span>
          <RadioCards name={`asset-${s.id}`} ariaLabel={`Files in release ${s.needsChoice.tag}`} columns={1} value={asset || null} onChange={setAsset}
            options={[...(browser ? [{ value: '[all]', label: 'All of them (one per browser)' }] : []), ...s.needsChoice.assets.map((a) => ({ value: a, label: a }))]} />
          <div style={{ marginTop: 'var(--tm-s-2)' }}>
            <button className="btn sm primary" disabled={busy || !asset || !canEdit} onClick={() => void run(async () => { await api.chooseAsset(s.id, s.needsChoice!.tag, asset); reload(); })}>Use this file</button>
          </div>
        </div>
      )}
      {canEdit && (
        <div className="row" style={{ marginTop: 'var(--tm-s-4)' }}>
          <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.checkSource(s.id); setInfo('Checked.'); reload(); })}>Check now</button>
          <button className="btn sm danger" disabled={busy} title="Disconnect the source. Versions stay." onClick={() => { if (confirm('Disconnect this source? Versions stay.')) void run(async () => { await api.removeSource(s.id); reload(); }); }}>Remove</button>
        </div>
      )}
    </div>
  );
}

export function SourcesTab({ p, reload }: { p: HubProject; reload: () => void }) {
  const { config } = useAuth();
  const canEdit = p.myRole === 'owner' || p.myRole === 'maintainer';
  const [url, setUrl] = useState('');
  const [product, setProduct] = useState('');
  const { busy, error, run } = useAction();
  return (
    <>
      <Notice tone="info">
        The hub reads connected repos by itself and picks up new releases. A GitHub App install makes it instant, but that is optional.
        {config.githubApp && <> <a href={config.githubApp} target="_blank" rel="noopener noreferrer">Install the GitHub App</a></>}
      </Notice>
      {p.sources.length === 0 && <EmptyState icon={<GitBranch size={22} />} title="No source connected" text="Add a GitHub repo or a TMLoader server below and new releases come in by themselves." />}
      {p.sources.map((s) => <SourceCard key={s.id} s={s} canEdit={canEdit} reload={reload} browser={p.type === 'browser-extension'} slug={p.slug} />)}
      {canEdit && (
        <Section title="Add source" help="Paste a GitHub repo link or the address of a TMLoader server.">
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.addSource(p.slug, { url, product: product || null }); setUrl(''); setProduct(''); reload(); }); }}>
          {error && <Notice tone="err">{error}</Notice>}
          <div className="cols2">
            <Field label="GitHub repo or TMLoader server URL"><input required placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
            <Field label="TMLoader product" hint="Only for TMLoader servers."><input value={product} onChange={(e) => setProduct(e.target.value)} /></Field>
          </div>
          <button className="btn primary" disabled={busy || !url.trim()}>{busy ? 'Adding' : 'Add'}</button>
        </form>
        </Section>
      )}
    </>
  );
}
