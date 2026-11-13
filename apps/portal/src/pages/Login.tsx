import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Notice, useAction } from '../ui/common.tsx';
import { Section } from '../ui/controls.tsx';
import { BRAND_MARKS, type LoginProvider } from '@tm-hub/shared/brandmarks';

export const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/');

const LOGIN_ERRORS: Record<string, string> = {
  suspended: 'This account is suspended.',
  cancelled: 'Login was cancelled.',
};

export function LoginPage() {
  const { user, config, refresh } = useAuth();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const next = safeNext(sp.get('next'));
  const { busy, error, run } = useAction();
  const urlError = sp.get('error');

  if (user) return <Navigate to={next} replace />;
  const providers = config.providers;
  const order: LoginProvider[] = ['github', 'discord'];

  return (
    <div className="login">
      <h1>Log in</h1>
      <p className="lead">Publish and manage your mods. You do not need tokens or keys to start.</p>
      {urlError && <Notice tone="err">{LOGIN_ERRORS[urlError] ?? `Login failed: ${urlError}`}</Notice>}
      <Section title="Your account" help="Used to publish mods, claim projects and add game servers.">
        {providers.length === 0 && <Notice tone="warn">No login provider is set up on this hub.</Notice>}
        <div className="brand-logins">
          {order.map((p) => {
            const m = BRAND_MARKS[p];
            const on = providers.includes(p);
            const body = <><svg viewBox={m.viewBox} aria-hidden="true" focusable="false"><path d={m.path} fill="currentColor" /></svg><span>Log in with {m.label}</span></>;
            const style = { background: m.bg, color: m.fg };
            return on
              ? <a key={p} className="brand-login" style={style} href={`/auth/${p}/start?next=${encodeURIComponent(next)}`}>{body}</a>
              : <span key={p} className="brand-login off" style={style} aria-disabled="true" title="Not set up on this hub">{body}</span>;
          })}
        </div>
        <p className="muted small" style={{ margin: 'var(--tm-s-4) 0 0' }}>
          By logging in you accept the <Link to="/legal/nutzungsbedingungen?lang=en">terms of use</Link>. What is stored: <Link to="/legal/datenschutz?lang=en">privacy policy</Link>.
        </p>
      </Section>
      {config.devLogin && (
        <div className="card dev">
          <div className="section-head"><h2>Development login</h2><span className="badge warn section-actions">Testing only</span></div>
          <p className="section-help">Made-up accounts. Not available on a live hub.</p>
          {error && <Notice tone="err">{error}</Notice>}
          <div className="row">
            {(['author', 'author2', 'admin', 'user'] as const).map((as) => (
              <button key={as} className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.devLogin(as); await refresh(); nav(next, { replace: true }); })}>
                {as === 'admin' ? 'Admin' : as === 'author' ? 'Author' : as === 'author2' ? 'Author 2' : 'User'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
