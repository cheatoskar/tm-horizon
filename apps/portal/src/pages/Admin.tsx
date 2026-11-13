import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReviewItem } from '@tm-hub/shared';
import { api, type AdminUser } from '../api.ts';
import { Async, Badge, Field, PageHead, Tabs, useAction, useAsync } from '../ui/common.tsx';
import { Checkbox, EmptyState } from '../ui/controls.tsx';
import { CheckReportView, StatementView } from '../ui/ReportView.tsx';
import { StatementModal } from '../ui/StatementForm.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { Discovered } from './AdminDiscovered.tsx';
import { REASON_LABELS, fmtDate, gameName } from '../labels.ts';
import { ServersAdmin } from '../ui/ServersAdmin.tsx';

type Sub = 'queue' | 'servers' | 'discovered' | 'users' | 'audit' | 'revocations' | 'notices';

function VersionItem({ it, done }: { it: ReviewItem; done: () => void }) {
  const v = it.version!;
  const { busy, error, run } = useAction();
  const [reject, setReject] = useState(false);
  const diff = v.report?.findings.filter((f) => f.code.startsWith('diff.')) ?? [];
  return (
    <div className="card">
      <div className="row">
        <Badge tone="info">version</Badge>
        <b><Link to={`/p/${it.project.slug}`}>{it.project.name}</Link> {v.version}</b>
        <Badge tone={v.status === 'review' ? 'warn' : 'info'}>{v.status}</Badge>
        {!it.project.claimed && <Badge tone="warn">unclaimed</Badge>}
        <span className="muted small">{fmtDate(it.created)}</span>
      </div>
      <div className="muted small" style={{ margin: 'var(--tm-s-2) 0' }}>Origin: {v.origin} | Uploader: {v.uploader?.name ?? 'unknown'} | {v.games.map(gameName).join(', ')}{v.verified ? ' | signed' : ''}</div>
      {diff.length > 0 && <div className="msg warn small">{diff.length} change(s) against the previous version: {diff.map((d) => d.message).join('; ')}</div>}
      {v.changelog && <details><summary className="small">Changelog</summary><div className="mdbox"><Markdown text={v.changelog} /></div></details>}
      {v.report ? <CheckReportView report={v.report} showFiles /> : <div className="muted small">No check report.</div>}
      {error && <div className="msg err" style={{ marginTop: 'var(--tm-s-3)' }}>{error}</div>}
      <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.approve(v.id); done(); })}>Approve</button>
        <button className="btn danger" disabled={busy} onClick={() => setReject(true)}>Reject</button>
      </div>
      {reject && <StatementModal title={`Reject ${it.project.name} ${v.version}`} submitLabel="Reject" onClose={() => setReject(false)} onSubmit={async (s) => { await api.rejectVersion(v.id, s); done(); }} />}
    </div>
  );
}

function ClaimItem({ it, done }: { it: ReviewItem; done: () => void }) {
  const c = it.claim!;
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <div className="row"><Badge tone="info">claim</Badge><b><Link to={`/p/${it.project.slug}`}>{it.project.name}</Link></b><span className="muted small">by {c.user.name} ({c.method}), {fmtDate(it.created)}</span></div>
      <div className="mdbox" style={{ margin: 'var(--tm-s-3) 0' }}>{c.detail}</div>
      {error && <div className="msg err">{error}</div>}
      <Field label="Note to the user (optional)"><input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.decideClaim(c.id, true, note || undefined); done(); })}>Approve</button>
        <button className="btn danger" disabled={busy} onClick={() => void run(async () => { await api.decideClaim(c.id, false, note || undefined); done(); })}>Reject</button>
      </div>
    </div>
  );
}

function ReportItem({ it, done }: { it: ReviewItem; done: () => void }) {
  const r = it.report!;
  const [text, setText] = useState('');
  const [modal, setModal] = useState<'remove' | 'revoke' | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="card" style={{ borderColor: 'var(--tm-accent-line)' }}>
      <div className="row"><Badge tone="bad">report</Badge><b><Link to={`/p/${it.project.slug}`}>{it.project.name}</Link></b><Badge>{REASON_LABELS[r.reason] ?? r.reason}</Badge><span className="muted small">{fmtDate(it.created)}</span></div>
      <p className="wrapword" style={{ margin: 'var(--tm-s-3) 0 var(--tm-s-2)' }}>{r.explanation}</p>
      <div className="muted small wrapword">Location: {r.location}{r.versionId ? ` | version ${r.versionId}` : ''}</div>
      <div className="muted small">From: {r.name || 'anonymous'}{r.email ? `, ${r.email}` : ', no e-mail'}</div>
      {error && <div className="msg err" style={{ marginTop: 'var(--tm-s-3)' }}>{error}</div>}
      <Field label="Answer to the notifier" hint="Required. This is the reason given for the outcome.">
        <textarea value={text} minLength={5} maxLength={2000} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="row">
        <button className="btn" disabled={busy || text.trim().length < 5} onClick={() => void run(async () => { await api.resolveReport(r.id, 'dismissed', text.trim()); done(); })}>Dismiss</button>
        <button className="btn primary" disabled={busy || text.trim().length < 5} onClick={() => void run(async () => { await api.resolveReport(r.id, 'actioned', text.trim()); done(); })}>Mark actioned</button>
        <span className="right row">
          {r.versionId && <button className="btn sm danger" onClick={() => setModal('revoke')}>Revoke version</button>}
          <button className="btn sm danger" onClick={() => setModal('remove')}>Remove project</button>
        </span>
      </div>
      {modal === 'revoke' && r.versionId && <StatementModal title="Revoke version" submitLabel="Revoke" onClose={() => setModal(null)} onSubmit={async (s) => { await api.revokeVersion(r.versionId!, s); done(); }} />}
      {modal === 'remove' && (
        <StatementModal title={`Remove ${it.project.name}`} submitLabel="Remove" onClose={() => setModal(null)} onSubmit={async (s, all) => { await api.removeProject(it.project.slug, { ...s, revokeAll: all }); done(); }}
          extra={({ value, set }) => <div className="field"><Checkbox checked={value} onChange={set} label="Also revoke every published version" /></div>} />
      )}
    </div>
  );
}

function Queue() {
  const r = useAsync(() => api.queue(), []);
  return (
    <Async r={r}>
      {(items) => items.length === 0 ? <EmptyState title="Nothing waiting" text="New reports, versions and claims show up here." /> : (
        <>
          <p className="muted small" style={{ marginBottom: 'var(--tm-s-4)' }}>Reports first (legal deadlines), then versions, then claims.</p>
          {items.map((it) => it.kind === 'report' ? <ReportItem key={it.id} it={it} done={r.reload} /> : it.kind === 'version' ? <VersionItem key={it.id} it={it} done={r.reload} /> : <ClaimItem key={it.id} it={it} done={r.reload} />)}
        </>
      )}
    </Async>
  );
}

function UserRow({ u, reload }: { u: AdminUser; reload: () => void }) {
  const [modal, setModal] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <div className="row">
        <b>{u.name}</b><Badge tone={u.role === 'admin' ? 'accent' : ''}>{u.role}</Badge>
        {u.suspended && <Badge tone="bad">suspended</Badge>}
        {u.strikes > 0 && <Badge tone="warn">{u.strikes} strike(s)</Badge>}
        <span className="muted small mono">{u.id}</span>
        <span className="right row">
          {u.suspended
            ? <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.unsuspend(u.id); reload(); })}>Unsuspend</button>
            : <button className="btn sm danger" onClick={() => setModal(true)}>Suspend</button>}
        </span>
      </div>
      <div className="muted small">{u.identities.map((i) => `${i.provider}:${i.username}`).join(', ')} | since {fmtDate(u.created)}</div>
      {error && <div className="msg err" style={{ marginTop: 'var(--tm-s-2)' }}>{error}</div>}
      {u.suspension && <div style={{ marginTop: 'var(--tm-s-3)' }}><StatementView s={u.suspension} /></div>}
      {modal && <StatementModal title={`Suspend ${u.name}`} submitLabel="Suspend" onClose={() => setModal(false)} onSubmit={async (s) => { await api.suspend(u.id, s); reload(); }} />}
    </div>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const r = useAsync(() => api.users(applied), [applied]);
  return (
    <>
      <form className="row" style={{ marginBottom: 'var(--tm-s-5)', flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); setApplied(q); }}>
        <input placeholder="Name or user id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <button className="btn">Search</button>
      </form>
      <Async r={r}>{(us) => us.length === 0 ? <EmptyState title="No accounts found" text="Try a different name or user id." /> : <>{us.map((u) => <UserRow key={u.id} u={u} reload={r.reload} />)}</>}</Async>
    </>
  );
}

function Audit() {
  const r = useAsync(() => api.audit(), []);
  return (
    <Async r={r}>{(rows) => (
      <div className="card"><div className="tablewrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>{rows.map((a) => (
          <tr key={a.id}><td className="nowrap">{fmtDate(a.at)}</td><td className="mono small wrapword">{a.actor}</td><td>{a.action}</td><td className="mono small wrapword">{a.target}</td>
            <td className="small wrapword" style={{ maxWidth: 360 }}>{a.detail ? JSON.stringify(a.detail).slice(0, 200) : ''}</td></tr>
        ))}</tbody>
      </table></div></div>
    )}</Async>
  );
}

function Revocations() {
  const r = useAsync(() => api.revocations(), []);
  return (
    <Async r={r}>{(rows) => rows.length === 0 ? <EmptyState title="No revoked versions" /> : (
      <div className="card"><div className="tablewrap"><table>
        <thead><tr><th>When</th><th>Project</th><th>Version</th><th>Reason</th><th>sha256</th></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.version_id}><td className="nowrap">{fmtDate(x.revoked_at)}</td><td>{x.project_slug}</td><td>{x.version}</td><td className="wrapword">{x.reason}</td><td className="mono small">{x.sha256.slice(0, 16)}</td></tr>)}</tbody>
      </table></div></div>
    )}</Async>
  );
}

function Notices() {
  const r = useAsync(() => api.notices(), []);
  return (
    <Async r={r}>{(rows) => rows.length === 0 ? <EmptyState title="No notices" text="Nothing has been logged since the server started." /> : (
      <div className="card">{rows.map((n, i) => <div key={i} className="finding"><Badge>{n.kind}</Badge><span>{n.text} <span className="muted small">{fmtDate(n.at)}</span></span></div>)}</div>
    )}</Async>
  );
}

export function AdminPage() {
  const [sub, setSub] = useState<Sub>('queue');
  const queue = useAsync(() => api.queue(), []);
  return (
    <div className="page">
      <PageHead title="Admin" />
      <Tabs value={sub} onChange={setSub} tabs={[{ id: 'queue', label: 'Review', badge: queue.data?.length }, { id: 'servers', label: 'Servers' }, { id: 'discovered', label: 'Discovered' }, { id: 'users', label: 'Users' }, { id: 'audit', label: 'Audit log' }, { id: 'revocations', label: 'Revocations' }, { id: 'notices', label: 'Notices' }]} />
      {sub === 'queue' && <Queue />}
      {sub === 'servers' && <ServersAdmin />}
      {sub === 'discovered' && <Discovered />}
      {sub === 'users' && <Users />}
      {sub === 'audit' && <Audit />}
      {sub === 'revocations' && <Revocations />}
      {sub === 'notices' && <Notices />}
    </div>
  );
}
