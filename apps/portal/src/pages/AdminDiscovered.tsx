// Admin > Discovered: TrackMania repositories the hub found on GitHub (docs/hub/discover-github.md).
// Accept = unclaimed link-only project (no install); Hide = out of the list for now; Ignore = never again.
import { useState } from 'react';
import { api, type DiscoveredItem } from '../api.ts';
import { Async, Badge, useAction, useAsync } from '../ui/common.tsx';
import { EmptyState } from '../ui/controls.tsx';
import { fmtDate, gameName } from '../labels.ts';

type State = 'new' | 'hidden' | 'ignored' | 'accepted';

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
