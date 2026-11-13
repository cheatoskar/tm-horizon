import { useState } from 'react';
import type { ApiTokenInfo } from '@tm-hub/shared';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Async, Badge, CopyButton, Field, Notice, PageHead, useAction, useAsync } from '../ui/common.tsx';
import { Checkbox, CheckCards, Section } from '../ui/controls.tsx';
import { fmtDate, fmtDay } from '../labels.ts';

function Identities() {
  const { user, config } = useAuth();
  return (
    <Section title="Logins" help="The accounts you can log in with. Link a second one to keep access if you lose the first.">
      {user!.identities.map((i) => (
        <div className="list-row" key={i.provider + i.providerId}>
          <Badge tone="info">{i.provider}</Badge><b>{i.username}</b><span className="muted small mono">{i.providerId}</span>
        </div>
      ))}
      <div className="row" style={{ marginTop: 'var(--tm-s-4)' }}>
        {config.providers.map((p) => <a key={p} className="btn sm" href={`/auth/${p}/start?intent=link&next=/account`}>Link {p === 'discord' ? 'Discord' : 'GitHub'}</a>)}
      </div>
      <p className="hint" style={{ marginTop: 'var(--tm-s-4)', marginBottom: 0 }}>Hub user id: <code>{user!.id}</code></p>
    </Section>
  );
}

function Keys() {
  const { user, refresh } = useAuth();
  const [key, setKey] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Section title="Signing keys" help={<>Optional. Sign a version with your own key and the launcher shows it as verified. Create a key with <code>npm run generate-key -w @tm-hub/server -- --author</code>, sign a file with the sign-version script, then paste the public key here.</>}>
      {error && <Notice tone="err">{error}</Notice>}
      {user!.keys.length === 0 && <p className="muted small">No keys yet.</p>}
      {user!.keys.map((k) => (
        <div className="list-row" key={k.keyId}>
          <code>{k.keyId}</code><span className="muted small">added {fmtDay(k.added)}</span>
          <button className="btn sm danger right" disabled={busy} onClick={() => { if (confirm('Remove this key?')) void run(async () => { await api.removeKey(k.keyId); await refresh(); }); }}>Remove</button>
        </div>
      ))}
      <form className="row" style={{ marginTop: 'var(--tm-s-4)', flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.addKey(key.trim()); setKey(''); await refresh(); }); }}>
        <input className="mono" placeholder="Public key (base64)" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Public key" />
        <button className="btn" disabled={busy || key.trim().length < 20}>Add</button>
      </form>
    </Section>
  );
}

function TokenRow({ t, onRevoke, busy }: { t: ApiTokenInfo; onRevoke: () => void; busy: boolean }) {
  return (
    <tr>
      <td><b>{t.name}</b></td>
      <td>{t.scopes.join(', ')}</td>
      <td>{t.projects ? `${t.projects.length} project(s)` : 'all'}</td>
      <td className="nowrap">{t.lastUsed ? fmtDay(t.lastUsed) : 'never'}</td>
      <td className="nowrap">{t.expires ? fmtDay(t.expires) : 'never'}</td>
      <td>{t.revoked ? <Badge tone="bad">revoked</Badge> : <button className="btn sm danger" disabled={busy} onClick={onRevoke}>Revoke</button>}</td>
    </tr>
  );
}

function Tokens() {
  const r = useAsync(() => api.tokens(), []);
  const projects = useAsync(() => api.myProjects(), []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['versions:write']);
  const [only, setOnly] = useState<string[]>([]);
  const [days, setDays] = useState<number | null>(180);
  const [fresh, setFresh] = useState<ApiTokenInfo | null>(null);
  const { busy, error, run } = useAction();
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  return (
    <Section title="API tokens" help="Only needed to upload from your own scripts or CI. Most authors just connect the repo.">
      {error && <Notice tone="err">{error}</Notice>}
      {fresh?.token && (
        <div className="msg ok">
          <b>Copy this token now. It is shown only once.</b>
          <pre style={{ marginTop: 'var(--tm-s-2)' }} className="wrapword">{fresh.token}</pre>
          <div className="row"><CopyButton text={fresh.token} /><button className="btn sm" onClick={() => setFresh(null)}>Done</button></div>
        </div>
      )}
      <Async r={r}>
        {(ts) => ts.length === 0 ? <p className="muted small">No tokens yet.</p> : (
          <div className="tablewrap" style={{ marginBottom: 'var(--tm-s-4)' }}><table>
            <thead><tr><th>Name</th><th>Scopes</th><th>Projects</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>{ts.map((t) => <TokenRow key={t.id} t={t} busy={busy} onRevoke={() => { if (confirm('Revoke this token?')) void run(async () => { await api.revokeToken(t.id); r.reload(); }); }} />)}</tbody>
          </table></div>
        )}
      </Async>
      <h3 style={{ marginTop: 'var(--tm-s-5)', paddingTop: 'var(--tm-s-4)', borderTop: '1px solid var(--line)' }}>New token</h3>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const t = await api.createToken({ name: name.trim(), scopes, projects: only.length ? only : null, expiresDays: days }); setFresh(t); setName(''); r.reload(); }); }}>
        <div className="cols2">
          <Field label="Name"><input required maxLength={60} placeholder="GitHub Action" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Expires">
            <select value={days ?? ''} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
              <option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>1 year</option><option value="">Never</option>
            </select>
          </Field>
        </div>
        <div className="field">
          <span className="lbl" id="tok-can">Can do</span>
          <div className="stack" role="group" aria-labelledby="tok-can">
            <Checkbox checked={scopes.includes('versions:write')} onChange={(on) => setScopes(toggle(scopes, 'versions:write', on))} label="Upload versions" hint="Send new files to the hub." />
            <Checkbox checked={scopes.includes('projects:read')} onChange={(on) => setScopes(toggle(scopes, 'projects:read', on))} label="Read my projects" hint="List your projects and their versions." />
          </div>
        </div>
        {projects.data && projects.data.length > 0 && (
          <div className="field">
            <span className="lbl">Only these projects</span>
            <CheckCards values={only} onChange={setOnly} columns={2} ariaLabel="Only these projects" options={projects.data.map((p) => ({ value: p.id, label: p.name, hint: p.slug }))} />
            <span className="hint">Leave empty for all of your projects.</span>
          </div>
        )}
        <button className="btn primary" disabled={busy || !name.trim() || scopes.length === 0}>Create</button>
      </form>
    </Section>
  );
}

function ActionExample() {
  const { config } = useAuth();
  const projects = useAsync(() => api.myProjects(), []);
  const [slug, setSlug] = useState('');
  const hub = config.publicUrl.replace(/\/$/, '');
  const s = slug || projects.data?.[0]?.slug || 'my-mod';
  const yaml = [
    'name: Publish to TM Horizon Hub',
    'on:',
    '  release:',
    '    types: [published]',
    'jobs:',
    '  hub:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      # build your zip first, then upload it',
    '      - name: Upload to the hub',
    '        run: |',
    '          curl -fsS -H "Authorization: Bearer ${{ secrets.TMHUB_TOKEN }}" \\',
    '            -F "file=@dist/Mod.zip" \\',
    '            -F \'meta={"version":"${{ github.ref_name }}","channel":"stable","changelog":"..."}\' \\',
    `            ${hub}/v1/projects/${s}/versions`,
  ].join('\n');
  return (
    <Section title="GitHub Action" help={<>Optional. Use it if a release should land on the hub from your own build. Save the token as the repository secret <code>TMHUB_TOKEN</code>.</>}>
      {projects.data && projects.data.length > 1 && (
        <Field label="Project"><select value={s} onChange={(e) => setSlug(e.target.value)}>{projects.data.map((p) => <option key={p.id} value={p.slug}>{p.name}</option>)}</select></Field>
      )}
      <pre>{yaml}</pre>
      <CopyButton text={yaml} />
    </Section>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  return (
    <div className="page narrow">
      <PageHead title="Account"><span className="muted">{user!.name}</span><Badge tone={user!.role === 'admin' ? 'accent' : ''}>{user!.role}</Badge><span className="muted small">since {fmtDate(user!.created)}</span></PageHead>
      <Identities />
      <Keys />
      <Tokens />
      <ActionExample />
    </div>
  );
}
