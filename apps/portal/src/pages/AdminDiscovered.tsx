// Admin > Discovered: TrackMania repositories the hub found on GitHub (docs/hub/discover-github.md).
// Accept = unclaimed link-only project (no install); Hide = out of the list for now; Ignore = never again.
import { useState } from 'react';
import { api, type CurationItem, type DiscoveredItem } from '../api.ts';
import { Async, Badge, useAction, useAsync } from '../ui/common.tsx';
import { EmptyState } from '../ui/controls.tsx';
import { fmtDate, gameName } from '../labels.ts';

type State = 'new' | 'hidden' | 'ignored' | 'accepted';

/** Waiting repositories sorted by the curation rules (docs/hub/curation.md): filter by bucket, reason code and text, then decide for the whole filter. */
function Curation({ done }: { done: () => void }) {
  const r = useAsync(() => api.curation(), []);
  const [bucket, setBucket] = useState<'all' | 'approve' | 'reject' | 'pending'>('pending');
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const act = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Async r={r}>{(d) => {
      const codes = Object.entries(bucket === 'all' ? Object.assign({}, ...Object.values(d.counts).map((c) => c.codes)) : d.counts[bucket]?.codes ?? {}) as [string, number][];
      const items: CurationItem[] = d.items.filter((i) => (bucket === 'all' || i.bucket === bucket) && (!code || i.code === code)
        && (!q || `${i.fullName} ${i.description ?? ''} ${i.reason}`.toLowerCase().includes(q.toLowerCase())));
      const decide = (action: 'accept' | 'hide') => {
        const what = action === 'accept' ? `Approve ${items.length} repositories as link-only entries?` : `Reject (hide) ${items.length} repositories? They can be brought back one by one.`;
        if (!items.length || !window.confirm(what)) return;
        void act.run(async () => { const b = await api.bulkDiscovered(items.map((i) => i.repo), action); setMsg(`${b.approved} approved, ${b.rejected} rejected${b.failed.length ? `, ${b.failed.length} failed` : ''}`); r.reload(); done(); });
      };
      return (
        <div className="card" style={{ marginBottom: 'var(--tm-s-4)' }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--tm-s-2)' }}>
            <b>Curation</b>
            {(['pending', 'approve', 'reject', 'all'] as const).map((b) => (
              <button key={b} className={`btn sm ${bucket === b ? 'primary' : ''}`} onClick={() => { setBucket(b); setCode(''); }}>{b === 'all' ? 'All' : b === 'approve' ? 'To approve' : b === 'reject' ? 'To reject' : 'To decide'} ({b === 'all' ? d.items.length : d.counts[b]?.n ?? 0})</button>
            ))}
            <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Reason"><option value="">Any reason</option>{codes.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}</select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, text or reason" aria-label="Search" />
          </div>
          <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>
            <button className="btn primary" disabled={act.busy || !items.length} onClick={() => decide('accept')}>Approve all in this filter ({items.length})</button>
            <button className="btn danger" disabled={act.busy || !items.length} onClick={() => decide('hide')}>Reject all in this filter ({items.length})</button>
            <span className="muted small">Approved = link-only entry, rejected = hidden with a reason (reversible).</span>
          </div>
          {(msg || act.error) && <div className={`msg ${act.error ? 'err' : 'ok'} small`} style={{ marginTop: 'var(--tm-s-2)' }}>{act.error ?? msg}</div>}
          <div className="small" style={{ marginTop: 'var(--tm-s-3)', maxHeight: 260, overflow: 'auto' }}>
            {items.slice(0, 200).map((i) => (
              <div key={i.repo} className="row" style={{ gap: 'var(--tm-s-2)' }}>
                <Badge tone={i.bucket === 'approve' ? 'accent' : i.bucket === 'reject' ? 'warn' : ''}>{i.code}</Badge>
                <a href={i.url} target="_blank" rel="noopener noreferrer">{i.fullName}</a>
                <span className="muted">{i.reason}</span>
              </div>
            ))}
            {items.length > 200 && <div className="muted">... and {items.length - 200} more (all are included in the buttons above)</div>}
          </div>
        </div>
      );
    }}</Async>
  );
}

function Row({ it, done }: { it: DiscoveredItem; done: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <div className="row">
        <b><a href={it.url} target="_blank" rel="noopener noreferrer">{it.fullName}</a></b>
        {it.language && <Badge>{it.language}</Badge>}
        {it.isFork && <Badge tone="warn" title="A fork that has releases of its own">fork</Badge>}
        {it.archived && <Badge tone="warn">archived</Badge>}
        {it.hasReadme === null && <Badge tone="warn" title="README not checked yet (GitHub limit)">README unchecked</Badge>}
        <span className="muted small">{it.stars} star{it.stars === 1 ? '' : 's'}{it.pushed ? `, pushed ${fmtDate(it.pushed)}` : ''}</span>
      </div>
      <p className="wrapword" style={{ margin: 'var(--tm-s-2) 0' }}>{it.description ?? <span className="muted">No description.</span>}</p>
      <div className="row small" style={{ gap: 'var(--tm-s-2)' }}>
        {it.topics.slice(0, 8).map((t) => <Badge key={t} tone={it.matchedTopics.includes(t) ? 'accent' : ''}>{t}</Badge>)}
        <span className="muted">Games{it.gamesGuessed ? ' (guessed)' : ''}: {it.games.map(gameName).join(', ')}</span>
      </div>
      {error && <div className="msg err small" style={{ marginTop: 'var(--tm-s-2)' }}>{error}</div>}
      <div className="row" style={{ marginTop: 'var(--tm-s-3)' }}>
        {it.state === 'new' && <>
          <button className="btn primary" disabled={busy} title="Creates an unclaimed project that only links to GitHub" onClick={() => void run(async () => { await api.acceptDiscovered(it.repo); done(); })}>Accept</button>
          <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.decideDiscovered(it.repo, 'hide'); done(); })}>Hide</button>
          <button className="btn danger" disabled={busy} title="Never show this repository again" onClick={() => void run(async () => { await api.decideDiscovered(it.repo, 'ignore'); done(); })}>Ignore</button>
        </>}
        {(it.state === 'hidden' || it.state === 'ignored') && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.decideDiscovered(it.repo, 'restore'); done(); })}>Back to the list</button>}
        {it.state === 'accepted' && it.projectSlug && <a className="btn sm" href={`/p/${it.projectSlug}`}>Open project</a>}
        <span className="muted small right">score {it.score}</span>
      </div>
    </div>
  );
}

export function Discovered() {
  const [state, setState] = useState<State>('new');
  const r = useAsync(() => api.discovered(state), [state]);
  const bulk = useAction();
  const search = useAction();
  const [result, setResult] = useState<string | null>(null);
  return (
    <Async r={r}>{(d) => {
      const withTopic = state === 'new' ? d.items.filter((i) => i.matchedTopics.length).length : 0;
      return (
        <>
          <div className="row" style={{ marginBottom: 'var(--tm-s-4)' }}>
            {(['new', 'hidden', 'ignored', 'accepted'] as State[]).map((s) => (
              <button key={s} className={`btn sm ${state === s ? 'primary' : ''}`} onClick={() => setState(s)}>{s === 'new' ? 'Waiting' : s[0]!.toUpperCase() + s.slice(1)} ({d.counts[s] ?? 0})</button>
            ))}
            <span className="right row">
              {d.enabled && <button className="btn sm" disabled={search.busy} title="Searches GitHub now (it also runs once a day)" onClick={() => void search.run(async () => { const s = await api.runDiscovery(); setResult(`Search done: ${s.added} new, ${s.requests} requests${s.error ? `, stopped: ${s.error}` : ''}`); r.reload(); })}>Search now</button>}
              {state === 'new' && <button className="btn sm primary" disabled={bulk.busy || !withTopic} title="Accepts every waiting repository that has at least one TrackMania topic" onClick={() => {
                if (!window.confirm(`Accept ${withTopic} repositories with a matching topic as link-only projects?`)) return;
                void bulk.run(async () => { const b = await api.acceptWithTopics(); setResult(`${b.accepted.length} accepted${b.failed.length ? `, ${b.failed.length} failed` : ''}`); r.reload(); });
              }}>Accept all with a matching topic ({withTopic})</button>}
            </span>
          </div>
          {state === 'new' && <Curation done={r.reload} />}
          {!d.enabled && <div className="msg warn small" style={{ marginBottom: 'var(--tm-s-3)' }}>The daily GitHub search is off (set DISCOVER_GITHUB=1 on the hub).</div>}
          {d.last && <p className="muted small" style={{ marginBottom: 'var(--tm-s-3)' }}>Last search {fmtDate(d.last.at)}: {d.last.seen} repositories seen, {d.last.added} new{d.last.error ? `. Stopped early: ${d.last.error}` : ''}</p>}
          {(result || bulk.error || search.error) && <div className={`msg ${bulk.error || search.error ? 'err' : 'ok'} small`} style={{ marginBottom: 'var(--tm-s-3)' }}>{bulk.error ?? search.error ?? result}</div>}
          {d.items.length === 0
            ? <EmptyState title={state === 'new' ? 'Nothing waiting' : 'Nothing here'} text={state === 'new' ? 'Repositories the daily search finds show up here.' : undefined} />
            : d.items.map((it) => <Row key={it.repo} it={it} done={r.reload} />)}
        </>
      );
    }}</Async>
  );
}
