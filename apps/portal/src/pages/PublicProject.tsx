import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, Flag } from 'lucide-react';
import type { HubProject, HubVersion } from '@tm-hub/shared';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Async, Badge, CopyButton, Pic, useAsync } from '../ui/common.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { ShowcaseView } from '@tm-hub/showcase-ui';
import '@tm-hub/showcase-ui/showcase.css';
import { useScheme } from '../ui/theme.ts';
import { Downloads, TypeIcon, typeLabel } from '../ui/ProjectType.tsx';
import { ReportDialog } from '../ui/ReportDialog.tsx';
import { StatementView } from '../ui/ReportView.tsx';
import { fmtDay, fmtSize, gameName } from '../labels.ts';

const LINKS: [Exclude<keyof HubProject['links'], 'related'>, string][] = [['homepage', 'Homepage'], ['source', 'Source'], ['issues', 'Issues'], ['discord', 'Discord']];

function VersionRow({ v, onReport }: { v: HubVersion; onReport: () => void }) {
  const f = v.files[0];
  return (
    <div className="card" style={{ marginBottom: 'var(--tm-s-3)' }}>
      <div className="row">
        <b style={{ fontSize: 16 }}>{v.version}</b>
        {v.channel === 'beta' && <Badge tone="accent">beta</Badge>}
        {v.status === 'revoked' && <Badge tone="bad">revoked</Badge>}
        {v.verified && <Badge tone="ok" title="Signed by the author.">signed</Badge>}
        <span className="muted small">{fmtDay(v.published ?? v.created)}</span>
        <span className="muted small" title="TM Horizon downloads of this version">{v.downloads} downloads</span>
        <span className="right row">
          <button className="btn sm ghost" onClick={onReport} title="Report this version"><Flag size={13} /> Report</button>
          {f && v.status === 'published' && <a className="btn sm primary" href={`/dl/${v.id}/${encodeURIComponent(f.name)}`}><Download size={14} /> Download</a>}
        </span>
      </div>
      {v.status === 'revoked' && v.decision && <div style={{ marginTop: 'var(--tm-s-3)' }}><StatementView s={v.decision} title="Why it was revoked" /></div>}
      {f && (
        <div className="small muted" style={{ marginTop: 'var(--tm-s-2)' }}>
          <span className="wrapword">{f.name}</span> ({fmtSize(f.size)}) | {v.games.map(gameName).join(', ')}
          <div className="row" style={{ marginTop: 'var(--tm-s-1)' }}>
            <span className="mono wrapword" style={{ fontSize: 11.5 }}>sha256 {f.sha256}</span><CopyButton text={f.sha256} label="Copy hash" />
          </div>
        </div>
      )}
      {v.changelog && <details style={{ marginTop: 'var(--tm-s-2)' }}><summary className="small">Changelog</summary><div className="mdbox"><Markdown text={v.changelog} /></div></details>}
    </div>
  );
}

function Page({ p }: { p: HubProject }) {
  const { user, config } = useAuth();
  const vs = useAsync(() => (p.state === 'removed' ? Promise.resolve([] as HubVersion[]) : api.versions(p.slug)), [p.slug]);
  const [report, setReport] = useState<{ id?: string; label?: string } | null>(null);
  const links = LINKS.filter(([k]) => p.links[k]);
  const scheme = useScheme();
  const vlist = vs.data ?? [];

  if (p.state === 'removed') {
    return (
      <div className="page narrow">
        <div className="row" style={{ marginBottom: 'var(--tm-s-4)' }}><Pic src={p.icon?.url} name={p.name} lg /><h1 style={{ margin: 0 }}>{p.name}</h1></div>
        <div className="msg err">This project was taken down.</div>
        {p.removal && <StatementView s={p.removal} />}
      </div>
    );
  }
  return (
    <div className="page">
      {p.banner && <img className="banner" src={p.banner.url} alt="" style={{ marginBottom: 'var(--tm-s-4)' }} />}
      <div className="row top" style={{ marginBottom: 'var(--tm-s-4)', flexWrap: 'nowrap' }}>
        <Pic src={p.icon?.url} name={p.name} lg />
        <div className="grow">
          <h1 style={{ marginBottom: 'var(--tm-s-1)' }}>{p.name}</h1>
          <div className="muted">by {p.author}</div>
          <div className="row" style={{ marginTop: 'var(--tm-s-2)' }}>
            {!p.claimed && <Badge tone="warn" title="Imported from a public catalog. The author has not claimed it yet.">Unclaimed</Badge>}
            {p.state !== 'listed' && <Badge tone="warn">{p.state}</Badge>}
            {p.type && <span className="row typechip" title="Project type"><TypeIcon type={p.type} size={14} />{typeLabel(p.type)}</span>}
            {p.license && <Badge>{p.license}</Badge>}
            <Downloads d={p.downloadStats} />
          </div>
        </div>
      </div>
      {!p.claimed && (
        <div className="msg warn">
          {p.discordClaimable && config.providers.includes('discord')
            ? <>Unclaimed. Are you the author? <a href={`/auth/discord/start?next=${encodeURIComponent(`/projects/${p.slug}`)}`}>Log in with Discord to claim it</a>. If you posted this mod on the modding Discord, the project is yours as soon as you log in with that account. <Link to={user ? `/projects/${p.slug}?tab=claim` : `/login?next=${encodeURIComponent(`/projects/${p.slug}?tab=claim`)}`}>Other ways to claim</Link></>
            : <>Is this yours? <Link to={user ? `/projects/${p.slug}?tab=claim` : `/login?next=${encodeURIComponent(`/projects/${p.slug}?tab=claim`)}`}>Claim it</Link></>}
        </div>
      )}
      {p.myRole && <p><Link className="btn sm" to={`/projects/${p.slug}`}>Edit project</Link></p>}
      <div className="pubgrid">
        <div>
          <p style={{ fontSize: 16 }}>{p.summary}</p>
          {p.showcase && (
            <div className="pub-showcase">
              <ShowcaseView showcase={p.showcase} scheme={scheme} ctx={{
                onInstall: () => { const v = vlist.find((x) => x.status === 'published'); if (v?.files[0]) window.location.href = `/dl/${v.id}/${encodeURIComponent(v.files[0].name)}`; },
                companion: p.links.related?.find((l) => l.kind === 'companion') ?? null, gameName,
                releases: vlist.filter((x) => x.status === 'published').map((x) => ({ version: x.version, notes: x.changelog })),
              }} />
            </div>
          )}
          {p.description && <div className="card">{p.showcase && <h2>Description</h2>}<Markdown text={p.description} title={p.name} demote={1} /></div>}
          {p.gallery.length > 0 && <div className="card"><h2>Screenshots</h2><div className="gallery">{p.gallery.map((g) => <a key={g.id} href={g.url} target="_blank" rel="noopener noreferrer"><img src={g.url} alt={g.caption ?? ''} loading="lazy" /></a>)}</div></div>}
          <h2>Versions</h2>
          <Async r={vs}>{(list) => {
            const shown = list.filter((v) => v.status === 'published' || v.status === 'revoked');
            return shown.length === 0 ? <div className="empty">No published version yet.</div> : <>{shown.map((v) => <VersionRow key={v.id} v={v} onReport={() => setReport({ id: v.id, label: v.version })} />)}</>;
          }}</Async>
        </div>
        <aside>
          <div className="card">
            <h3>Details</h3>
            <table><tbody>
              <tr><th>Games</th><td>{p.games.map(gameName).join(', ') || '-'}</td></tr>
              <tr><th>Categories</th><td>{p.categories.join(', ') || '-'}</td></tr>
              <tr><th>Tags</th><td>{p.tags.join(', ') || '-'}</td></tr>
              <tr><th>Updated</th><td>{fmtDay(p.updated)}</td></tr>
            </tbody></table>
            {(p.links.related ?? []).length > 0 && <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>{(p.links.related ?? []).map((l) => <a key={l.url} className={'btn sm' + (l.kind === 'companion' ? ' primary' : '')} href={l.url} target="_blank" rel="noopener noreferrer nofollow" title={l.kind}>{l.label}</a>)}</div>}
            {links.length > 0 && <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>{links.map(([k, l]) => <a key={k} className="btn sm" href={p.links[k]} target="_blank" rel="noopener noreferrer nofollow">{l}</a>)}</div>}
            {(p.dependencies.length > 0 || p.conflicts.length > 0) && (
              <div className="small" style={{ marginTop: 'var(--tm-s-3)' }}>
                {p.dependencies.length > 0 && <div>Needs: {p.dependencies.map((d) => d.id + (d.version ? ` ${d.version}` : '')).join(', ')}</div>}
                {p.conflicts.length > 0 && <div>Conflicts: {p.conflicts.map((d) => d.id).join(', ')}</div>}
              </div>
            )}
          </div>
          <button className="btn sm ghost" onClick={() => setReport({})}><Flag size={13} /> Report</button>
        </aside>
      </div>
      {report && <ReportDialog slug={p.slug} versionId={report.id} versionLabel={report.label} onClose={() => setReport(null)} />}
    </div>
  );
}

export function PublicProjectPage() {
  const { slug = '' } = useParams();
  const r = useAsync(() => api.project(slug), [slug]);
  return <Async r={r}>{(p) => <Page p={p} />}</Async>;
}
