// Admin screen for game servers (docs/hub/server-registration.md): pending, verified (listed by the hub's own
// check), approved (operator has a token), removed, rejected. Approve, reject, remove, restore, re-check.
import { useState } from 'react';
import { api, type AdminServer } from '../api.ts';
import { Async, Badge, Tabs, useAction, useAsync } from './common.tsx';
import { fmtDate, gameName } from '../labels.ts';

type Status = 'pending' | 'verified' | 'approved' | 'removed' | 'rejected';
const STATUSES: Status[] = ['pending', 'verified', 'approved', 'removed', 'rejected'];

function Row({ s, done, onToken }: { s: AdminServer; done: () => void; onToken: (name: string, token: string) => void }) {
  const { busy, error, run } = useAction();
  const [answer, setAnswer] = useState<string | null>(null);
  const info = s.check_info;
  const act = (f: () => Promise<unknown>) => void run(async () => { await f(); done(); });
  return (
    <tr>
      <td>
        <b className="wrapword">{s.name}</b>
        <div className="muted small">{gameName(s.game as never)} <span className="mono">{s.address}</span></div>
        {s.homepage && <div className="small wrapword"><a href={s.homepage} target="_blank" rel="noreferrer noopener">{s.homepage}</a></div>}
      </td>
      <td className="small wrapword" style={{ maxWidth: 200 }}>
        {s.contact || <span className="muted">none</span>}
        <div>{s.submitter_id ? <Badge tone={s.owner ? 'good' : 'info'}>{s.owner ? 'owner' : 'suggested'}</Badge> : <Badge>anonymous</Badge>}</div>
      </td>
      <td className="small">
        {info ? <>{info.players}/{info.maxPlayers} players{info.map ? `, ${info.map}` : ''}{info.mode ? `, ${info.mode}` : ''}{info.password && <> <Badge tone="warn">password</Badge></>}</> : <span className="muted">no answer yet</span>}
        <div className="muted">{s.last_check_at ? `checked ${fmtDate(s.last_check_at)}` : 'never checked'}</div>
        {s.offline_since && <div><Badge tone="bad">offline since {fmtDate(s.offline_since)}</Badge></div>}
        {answer && <div>Now: {answer}</div>}
      </td>
      <td className="small wrapword" style={{ maxWidth: 180 }}>{s.note}<div className="muted">{fmtDate(s.created_at)}</div></td>
      <td>
        {error && <div className="msg err small">{error}</div>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(s.status === 'pending' || s.status === 'verified' || s.status === 'approved') && (
            <button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.recheckServer(s.id); setAnswer(r.result); done(); })}>Re-check</button>
          )}
          {s.status === 'pending' && <button className="btn sm primary" disabled={busy} onClick={() => void run(async () => { onToken(s.name, (await api.approveServer(s.id, !!s.contact)).token); done(); })}>Approve</button>}
          {s.status === 'verified' && <button className="btn sm" disabled={busy} title="The operator is known: issue the announce token" onClick={() => void run(async () => { onToken(s.name, (await api.approveServer(s.id, true)).token); done(); })}>Issue token</button>}
          {s.status === 'approved' && <button className="btn sm" disabled={busy} title="Kills the old token" onClick={() => void run(async () => { onToken(s.name, (await api.approveServer(s.id, false)).token); done(); })}>New token</button>}
          {s.status === 'pending' && <button className="btn sm danger" disabled={busy} onClick={() => act(() => api.rejectServer(s.id, window.prompt('Note (optional)') ?? ''))}>Reject</button>}
          {(s.status === 'verified' || s.status === 'approved') && <button className="btn sm danger" disabled={busy} onClick={() => act(() => api.removeServer(s.id, window.prompt('Note (optional)') ?? ''))}>Remove</button>}
          {(s.status === 'removed' || s.status === 'rejected') && <button className="btn sm" disabled={busy} onClick={() => act(() => api.restoreServer(s.id))}>Restore</button>}
        </div>
      </td>
    </tr>
  );
}

export function ServersAdmin() {
  const [status, setStatus] = useState<Status>('pending');
  const r = useAsync(() => api.servers(status), [status]);
  const { busy, error, run } = useAction();
  const [started, setStarted] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  return (
    <>
      <div className="row" style={{ margin: 'var(--tm-s-3) 0' }}>
        <Tabs value={status} onChange={setStatus} tabs={STATUSES.map((id) => ({ id, label: id }))} />
        <span className="right">
          <button className="btn sm" disabled={busy} title="Asks every listed server again, one after another" onClick={() => void run(async () => { await api.recheckAllServers(); setStarted(true); })}>Re-check all</button>
        </span>
      </div>
      {issued && <div className="msg ok small wrapword">Token for {issued.name}, shown once. Send it to the operator: <code>{issued.token}</code></div>}
      {started && <div className="msg ok small">Re-check started. It takes a while; reload the list later.</div>}
      {error && <div className="msg err">{error}</div>}
      <Async r={r}>{(rows) => rows.length === 0 ? <div className="empty">No {status} servers.</div> : (
        <div className="card"><div className="tablewrap"><table>
          <thead><tr><th>Server</th><th>Contact</th><th>Last answer</th><th>Note</th><th></th></tr></thead>
          <tbody>{rows.map((s) => <Row key={s.id} s={s} done={r.reload} onToken={(name, token) => setIssued({ name, token })} />)}</tbody>
        </table></div></div>
      )}</Async>
    </>
  );
}
