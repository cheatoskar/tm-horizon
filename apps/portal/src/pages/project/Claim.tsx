import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HubProject } from '@tm-hub/shared';
import { api } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { Async, Badge, CopyButton, Field, Notice, useAction, useAsync } from '../../ui/common.tsx';
import { Section } from '../../ui/controls.tsx';
import { fmtDate } from '../../labels.ts';

export function ClaimTab({ p, reload }: { p: HubProject; reload: () => void }) {
  const { config } = useAuth();
  const nav = useNavigate();
  const mine = useAsync(() => api.myClaims(), [p.slug]);
  const tm = useAction();
  const manual = useAction();
  const dev = useAction();
  const verify = useAction();
  const [message, setMessage] = useState('');
  const [verified, setVerified] = useState<boolean | null>(null);
  const tmSource = p.sources.find((s) => s.kind === 'tmloader');
  const server = tmSource?.target ?? '<your TMLoader server>/';
  const github = config.providers.includes('github');

  if (p.claimed) return <Notice tone="ok">This project is claimed.</Notice>;
  return (
    <>
      <Notice tone="info">
        This project was imported from a public catalog and credits <b>{p.author}</b>. If it is yours, claim it. You then manage it here.
      </Notice>

      {p.discordClaimable && config.providers.includes('discord') && (
        <Section title="Claim with Discord" help="This mod was posted on the modding Discord. Log in with the Discord account that posted it and the project becomes yours at once.">
          <a className="btn primary" href={`/auth/discord/start?next=${encodeURIComponent(`/projects/${p.slug}`)}`}>Log in with Discord</a>
        </Section>
      )}

      <Section title="Claim with GitHub" help="Works when you are admin of the project's repo. GitHub only confirms that once, the hub keeps no token.">
        <div className="row">
          {github ? (
            <a className="btn primary" href={`/auth/github/start?intent=claim:${encodeURIComponent(p.slug)}&next=${encodeURIComponent(`/projects/${p.slug}`)}`}>Claim with GitHub</a>
          ) : <span className="muted small">GitHub login is not set up on this hub.</span>}
          {config.devLogin && (
            <button className="btn" disabled={dev.busy} title="Development only. Acts as if GitHub confirmed repo admin rights." onClick={() => void dev.run(async () => { const r = await api.devGithubClaim(p.slug); reload(); nav(r.next || `/projects/${p.slug}`); })}>
              Dev claim
            </button>
          )}
        </div>
        {dev.error && <div style={{ marginTop: 'var(--tm-s-3)' }}><Notice tone="err">{dev.error}</Notice></div>}
      </Section>

      <Section title="Claim with TMLoader token" help="For projects from a TMLoader server. You get a token and prove you run the server by putting it into a file there.">
        {tm.error && <Notice tone="err">{tm.error}</Notice>}
        <Async r={mine}>
          {(rows) => {
            const pending = rows.filter((c) => c.slug === p.slug && c.status === 'pending');
            const tok = pending.find((c) => c.method === 'tmloader-token');
            return (
              <>
                {tok ? (
                  <div className="stack">
                    <div className="msg">
                      Put this token into <code className="wrapword">{server}tmhub-claim.txt</code>, then press Verify.
                      <pre style={{ marginTop: 'var(--tm-s-2)' }}>{tok.detail}</pre>
                      <CopyButton text={tok.detail} />
                    </div>
                    {verify.error && <Notice tone="err">{verify.error}</Notice>}
                    {verified === false && <Notice tone="warn">The file was not found or does not match yet.</Notice>}
                    <button className="btn primary" disabled={verify.busy} onClick={() => void verify.run(async () => { const r = await api.verifyClaim(tok.id); setVerified(r.ok); if (r.ok) { reload(); nav(`/projects/${p.slug}`); } })}>Verify</button>
                  </div>
                ) : (
                  <button className="btn" disabled={tm.busy} onClick={() => void tm.run(async () => { await api.requestClaim(p.slug, 'tmloader-token'); mine.reload(); })}>Get token</button>
                )}
                {pending.filter((c) => c.method === 'manual').map((c) => <div key={c.id} className="msg" style={{ marginTop: 'var(--tm-s-3)' }}>Manual request sent {fmtDate(c.created_at)} <Badge tone="warn">pending</Badge></div>)}
              </>
            );
          }}
        </Async>
      </Section>

      <Section title="Ask an admin" help="If the other ways do not fit, tell us why the project is yours. An admin decides.">
      <form onSubmit={(e) => { e.preventDefault(); void manual.run(async () => { await api.requestClaim(p.slug, 'manual', message); setMessage(''); mine.reload(); }); }}>
        {manual.error && <Notice tone="err">{manual.error}</Notice>}
        <Field label="Message" hint="Links that show it is yours help (repo, site, Discord).">
          <textarea required minLength={10} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <button className="btn" disabled={manual.busy || message.trim().length < 10}>Send request</button>
      </form>
      </Section>
    </>
  );
}
