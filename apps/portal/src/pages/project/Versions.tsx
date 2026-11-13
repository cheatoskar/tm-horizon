import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PROJECT_TYPES, type HubProject, type HubSource, type HubVersion } from '@tm-hub/shared';
import { api, type VersionMeta } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { Async, Badge, Field, Notice, useAction, useAsync } from '../../ui/common.tsx';
import { EmptyState, FileDrop, RadioCards, Section } from '../../ui/controls.tsx';
import { githubRepoOf } from './ImportGithub.tsx';
import { PackageOpen } from 'lucide-react';
import { MarkdownEditor, Markdown } from '../../ui/Markdown.tsx';
import { CheckReportView, StatementView } from '../../ui/ReportView.tsx';
import { STATUS_TONE, fmtDate, fmtSize, gameName } from '../../labels.ts';

const STATUS_HELP: Record<string, string> = {
  checking: 'Checks are still running.',
  held: 'Clean update. It goes live after the hold unless you cancel.',
  review: 'A person at the hub looks at it before it goes live.',
  published: 'Live.',
  rejected: 'Refused. Nothing was published.',
  cancelled: 'Stopped by you.',
  revoked: 'Taken back after publishing.',
};

function VersionCard({ v, canEdit, reload }: { v: HubVersion; canEdit: boolean; reload: () => void }) {
  const [open, setOpen] = useState(v.status === 'review' || v.status === 'rejected' || v.status === 'held');
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <div className="row">
        <b style={{ fontSize: 16 }}>{v.version}</b>
        <Badge tone={STATUS_TONE[v.status]} title={STATUS_HELP[v.status]}>{v.status}</Badge>
        {v.channel === 'beta' && <Badge tone="accent">beta</Badge>}
        {v.verified && <Badge tone="ok" title="The author signature matches one of your keys.">signed</Badge>}
        <span className="muted small">{fmtDate(v.published ?? v.created)}</span>
        <span className="muted small">{v.downloads} downloads</span>
        <button className="btn sm ghost right" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Details'}</button>
      </div>
      {v.status === 'held' && v.publishAt && (
        <div className="msg warn" style={{ marginTop: 'var(--tm-s-3)' }}>
          <div className="row">
            <span>Goes live at <b>{fmtDate(v.publishAt)}</b>.</span>
            {canEdit && <button className="btn sm danger right" disabled={busy} onClick={() => void run(async () => { await api.cancelVersion(v.id); reload(); })}>Cancel</button>}
          </div>
        </div>
      )}
      {v.status === 'review' && canEdit && (
        <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>
          <span className="muted small">Waiting for a decision.</span>
          <button className="btn sm danger right" disabled={busy} onClick={() => void run(async () => { await api.cancelVersion(v.id); reload(); })}>Withdraw</button>
        </div>
      )}
      {error && <div style={{ marginTop: 'var(--tm-s-3)' }}><Notice tone="err">{error}</Notice></div>}
      {v.decision && <div style={{ marginTop: 'var(--tm-s-3)' }}><StatementView s={v.decision} /></div>}
      {open && (
        <div className="stack" style={{ marginTop: 'var(--tm-s-3)' }}>
          <div className="muted small">Origin: {v.origin}{v.uploader ? `, by ${v.uploader.name}` : ''} | Games: {v.games.map(gameName).join(', ')}</div>
          {v.changelog && <div className="mdbox"><Markdown text={v.changelog} /></div>}
          {v.files.length > 0 && (
            <div className="tablewrap"><table><tbody>
              {v.files.map((f) => <tr key={f.name}><td className="wrapword">{f.name}</td><td className="nowrap">{fmtSize(f.size)}</td><td className="mono small wrapword" title={f.sha256}>{f.sha256.slice(0, 16)}</td></tr>)}
            </tbody></table></div>
          )}
          {v.report ? <CheckReportView report={v.report} /> : <div className="muted small">No check report yet.</div>}
        </div>
      )}
    </div>
  );
}

function UploadForm({ p, onDone }: { p: HubProject; onDone: () => void }) {
  const { config } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [changelog, setChangelog] = useState('');
  const [keyId, setKeyId] = useState('');
  const [sig, setSig] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [ok, setOk] = useState<HubVersion | null>(null);
  const { busy, error, run } = useAction();

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!file) return;
      void run(async () => {
        const meta: VersionMeta = { version: version.trim(), channel, changelog };
        if (keyId.trim() && sig.trim()) meta.signature = { keyId: keyId.trim(), sig: sig.trim() };
        const f = new FormData();
        f.append('meta', JSON.stringify(meta));
        f.append('file', file);
        setProgress(0);
        try {
          const v = await api.uploadVersion(p.slug, f, setProgress);
          setOk(v);
          setFile(null); setVersion(''); setChangelog(''); setKeyId(''); setSig('');
          onDone();
        } finally { setProgress(null); }
      });
    }}>
      {error && <Notice tone="err">{error}</Notice>}
      {ok && <Notice tone="ok">Uploaded {ok.version}: <b>{ok.status}</b>. {STATUS_HELP[ok.status]}</Notice>}
      <div className="field">
        <span className="lbl">Release file</span>
        <FileDrop accept=".zip,.dll" file={file} onFile={setFile} label="Choose the release file" hint={`Zip or DLL, up to ${config.maxUploadMb} MB.`} />
      </div>
      <div className="cols2">
        <Field label="Version" hint="Like 1.2.0 or 1.2.0-beta.1">
          <input required placeholder="1.0.0" value={version} onChange={(e) => setVersion(e.target.value)} />
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(e.target.value as 'stable' | 'beta')}><option value="stable">Stable</option><option value="beta">Beta</option></select>
        </Field>
      </div>
      <Field label="Changelog" hint="Markdown."><MarkdownEditor value={changelog} onChange={setChangelog} rows={6} /></Field>
      <details style={{ marginBottom: 'var(--tm-s-3)' }}>
        <summary className="small">Author signature (optional)</summary>
        <div className="cols2" style={{ marginTop: 'var(--tm-s-3)' }}>
          <Field label="Key id" hint="16 hex characters, from your account page."><input className="mono" value={keyId} onChange={(e) => setKeyId(e.target.value)} /></Field>
          <Field label="Signature" hint="Base64 from the sign-version script."><input className="mono" value={sig} onChange={(e) => setSig(e.target.value)} /></Field>
        </div>
      </details>
      {progress !== null && <div className="progress" style={{ marginBottom: 'var(--tm-s-3)' }} aria-label="Upload progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
      <button className="btn primary" disabled={busy || !file}>{busy ? (progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Working') : 'Upload'}</button>
    </form>
  );
}

/** Needs games and an install type before a release can be taken (browser extensions and link-only types never do). */
const missingInstall = (p: HubProject) => Object.keys(p.installs).length === 0 && !(p.type && ['browser', 'link'].includes(PROJECT_TYPES[p.type].delivery));

/** Leads the Versions tab: is a source connected, when was it checked, did it find files. */
function SourceState({ p, s, canEdit, reload }: { p: HubProject; s: HubSource | undefined; canEdit: boolean; reload: () => void }) {
  const { busy, error, run } = useAction();
  const [asset, setAsset] = useState(s?.needsChoice?.assets[0] ?? '');
  const [info, setInfo] = useState<string | null>(null);
  const repo = githubRepoOf(p);
  if (!s) {
    return (
      <Section title="Source">
        {repo
          ? <p style={{ marginTop: 0 }}>Not connected. The repository <b className="wrapword">{repo}</b> is known: connect it and new releases come in by themselves, each one still through the checks.</p>
          : <p style={{ marginTop: 0 }} className="muted">No repository connected. Connect one under <Link to={`/projects/${p.slug}?tab=sources`}>Sources</Link> or upload a file below.</p>}
        {error && <Notice tone="err">{error}</Notice>}
        {repo && canEdit && <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.addSource(p.slug, { url: `https://github.com/${repo}` }); reload(); })}>{busy ? 'Connecting' : `Connect ${repo}`}</button>}
        {missingInstall(p) && repo && <p className="hint" style={{ marginBottom: 0 }}>Games and install type are not set yet: <Link to={`/projects/${p.slug}?tab=import`}>Import from GitHub</Link> sets them.</p>}
      </Section>
    );
  }
  return (
    <Section title="Source" actions={<Badge tone="info">{s.kind === 'github' ? 'GitHub' : 'TMLoader'}</Badge>}>
      <div className="row">
        <span>Connected to {s.kind === 'github' ? 'GitHub' : 'TMLoader'}: <b className="wrapword">{s.target}</b></span>
        <span className="muted small">Last check {s.lastCheck ? fmtDate(s.lastCheck) : 'not yet'}</span>
        {canEdit && <button className="btn sm right" disabled={busy} onClick={() => void run(async () => { await api.checkSource(s.id); setInfo('Checked.'); reload(); })}>Check now</button>}
      </div>
      {missingInstall(p) && <div style={{ marginTop: 'var(--tm-s-3)' }}><Notice tone="warn">Games and install type are not set, so no release can be taken yet. <Link to={`/projects/${p.slug}?tab=import`}>Import from GitHub</Link> or the Details tab sets them.</Notice></div>}
      {s.lastError && !missingInstall(p) && <div style={{ marginTop: 'var(--tm-s-3)' }}><Notice tone="err">{s.lastError}</Notice></div>}
      {error && <Notice tone="err">{error}</Notice>}
      {info && <Notice tone="ok">{info}</Notice>}
      {s.needsChoice && (
        <div className="field" style={{ marginTop: 'var(--tm-s-3)' }}>
          <span className="lbl">Release {s.needsChoice.tag} has several files</span>
          <span className="hint">Pick the one to install. The hub remembers it for later releases.</span>
          <RadioCards name={`vasset-${s.id}`} ariaLabel={`Files in release ${s.needsChoice.tag}`} columns={1} value={asset || null} onChange={setAsset}
            options={s.needsChoice.assets.map((a) => ({ value: a, label: a }))} />
          <div style={{ marginTop: 'var(--tm-s-2)' }}>
            <button className="btn sm primary" disabled={busy || !asset || !canEdit} onClick={() => void run(async () => { await api.chooseAsset(s.id, s.needsChoice!.tag, asset); reload(); })}>Use this file</button>
          </div>
        </div>
      )}
    </Section>
  );
}

export function VersionsTab({ p, reloadProject }: { p: HubProject; reloadProject: () => void }) {
  const r = useAsync(() => api.versions(p.slug), [p.slug]);
  const canEdit = p.myRole === 'owner' || p.myRole === 'maintainer';
  const canUpload = !!p.myRole;
  const source = p.sources.find((x) => x.kind === 'github') ?? p.sources[0];
  const hasSource = !!source || !!githubRepoOf(p);
  return (
    <>
      {canUpload && <SourceState p={p} s={source} canEdit={canEdit} reload={() => { r.reload(); reloadProject(); }} />}
      <Async r={r}>
        {(vs) => vs.length === 0
          ? <EmptyState icon={<PackageOpen size={22} />} title="No versions yet" text="Published versions show up here with their check results." />
          : vs.map((v) => <VersionCard key={v.id} v={v} canEdit={canEdit} reload={() => { r.reload(); reloadProject(); }} />)}
      </Async>
      {canUpload && (
        <details className="imp-details" open={!hasSource} style={{ marginTop: 'var(--tm-s-4)' }}>
          <summary>Upload a file yourself</summary>
          <p className="hint">Only needed when there are no GitHub releases to take, or for builds you do not publish there.</p>
          <UploadForm p={p} onDone={() => { r.reload(); reloadProject(); }} />
        </details>
      )}
    </>
  );
}
