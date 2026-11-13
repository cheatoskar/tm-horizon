// Hub account in the launcher: login with GitHub or Discord (system browser + loopback, data/hubAuth.ts),
// the Settings block, sending a game server to the hub and claiming a mod. While the hub is not
// reachable everything stays calm: one status line, disabled buttons with a tooltip, the old paths
// (issue text) keep working.
import { useState } from 'react';
import { ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { BRAND_MARKS, type LoginProvider } from '@tm-hub/shared/brandmarks';
import { backend, isNative } from '../data/backend';
import { canUseHub, cancelHubLogin, hubLogin, hubLogout, hubRequest, privacyUrl, refreshHubLogin, useHubLogin, type HubLoginState } from '../data/hubAuth';
import { getHubSource, hubPayload } from '../data/hubIndex';
import { useHubState } from '../state';
import { useI18n, useT } from '../i18n';
import { Modal } from './Modal';
import '../styles-hublogin.css';

const ORDER: LoginProvider[] = ['github', 'discord'];

/** Why the login buttons are off (null: they work). */
function offReason(s: HubLoginState, t: ReturnType<typeof useT>): string | null {
  if (!isNative) return t('hubLogin.appOnly');
  if (!s.hub && !getHubSource().url.trim()) return t('hubLogin.noUrlTip');
  if (s.phase === 'checking') return t('hubLogin.checking');
  if (!s.reachable) return t('hubLogin.unreachableTip');
  return null;
}

export function loginError(code: string, t: ReturnType<typeof useT>): string {
  if (code.startsWith('denied:')) return t('hubLogin.err.denied');
  if (code === 'timeout') return t('hubLogin.err.timeout');
  if (code === 'cancelled') return t('hubLogin.err.denied');
  if (code === 'unreachable' || code === 'bad-hub') return t('hubLogin.unreachable');
  return t('hubLogin.err.other', { code });
}

/** The two large brand buttons. `claim`: GitHub login that also claims this project slug. */
export function BrandLoginButtons({ onDone, claim }: { onDone?: (claimed: boolean) => void; claim?: string }) {
  const t = useT();
  const hub = useHubState();
  const s = useHubLogin();
  const off = offReason(s, t);
  const busy = s.phase === 'busy';
  const go = async (p: LoginProvider) => {
    const r = await hubLogin(p, p === 'github' ? claim : undefined);
    if (r.ok) { hub.toast({ ok: true, message: r.claimed ? t('hubLogin.claim.done') : t('hubLogin.loggedIn') }); onDone?.(r.claimed); }
    else if (r.error !== 'cancelled') hub.toast({ ok: false, message: loginError(r.error, t) });
  };
  return (
    <div className="hub-logins">
      {ORDER.filter((p) => !claim || p === 'github').map((p) => {
        const m = BRAND_MARKS[p];
        const notOffered = !off && s.providers.length > 0 && !s.providers.includes(p);
        const tip = off ?? (notOffered ? t('hubLogin.notOffered') : undefined);
        return (
          <button key={p} className="hub-login-btn" disabled={!!off || notOffered || busy} title={tip} onClick={() => void go(p)}
            style={{ ['--hb-bg' as string]: m.bg, ['--hb-fg' as string]: m.fg, ['--hb-bg-l' as string]: m.bgLight, ['--hb-fg-l' as string]: m.fgLight }}>
            <svg viewBox={m.viewBox} aria-hidden="true" focusable="false"><path d={m.path} fill="currentColor" /></svg>
            <span>{t(p === 'github' ? (claim ? 'hubLogin.claim.github' : 'hubLogin.github') : 'hubLogin.discord')}</span>
          </button>
        );
      })}
      {busy && (
        <div className="hub-login-wait small dim">
          <Loader2 size={14} className="spin" /> {t('hubLogin.waiting')}
          <button className="linkish small" onClick={() => void cancelHubLogin()}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
  );
}

/** Calm one-line status while the hub cannot be used. */
function HubStatusLine({ s }: { s: HubLoginState }) {
  const t = useT();
  const off = offReason(s, t);
  if (!off || s.phase === 'checking') return null;
  return (
    <div className="hub-login-status small dim" title={off}>
      <span className="dot" /> {t('hubLogin.unreachable')}
      {isNative && <button className="btn icon tiny" title={t('hubLogin.retry')} aria-label={t('hubLogin.retry')} onClick={() => void refreshHubLogin(true)}><RefreshCw size={12} /></button>}
    </div>
  );
}

const PrivacyLink = ({ s }: { s: HubLoginState }) => {
  const { t, lang } = useI18n();
  return <button className="linkish small" onClick={() => backend.openExternal(privacyUrl(s, lang))}>{t('hubLogin.privacy')} <ExternalLink size={11} /></button>;
};

/** Settings > Hub-Konto. */
export function HubAccountBlock() {
  const t = useT();
  const s = useHubLogin();
  if (!isNative) return null;
  return (
    <section className="panel hub-account">
      <div className="setrow">
        <div className="grow">
          <b>{t('hubLogin.title')}</b>
          <div className="dim small setnote">{t('hubLogin.why')} <PrivacyLink s={s} /></div>
        </div>
      </div>
      {s.user ? (
        <div className="setrow">
          {s.user.avatar ? <img className="hub-avatar" src={s.user.avatar} alt="" /> : <span className="hub-avatar empty">{s.user.name.slice(0, 1).toUpperCase()}</span>}
          <div className="grow"><b>{t('hubLogin.signedIn', { name: s.user.name })}</b>{!s.reachable && <HubStatusLine s={s} />}</div>
          <button className="btn ghost sm" onClick={() => void hubLogout()}><LogOut size={14} /> {t('hubLogin.logout')}</button>
        </div>
      ) : (
        <div className="setrow column">
          <BrandLoginButtons />
          <HubStatusLine s={s} />
        </div>
      )}
    </section>
  );
}

/** One line under the issue-text fallback: logging in sends it directly. */
export function HubLoginHint() {
  const t = useT();
  if (!isNative) return null;
  return <p className="small dim hub-login-hint">{t('hubLogin.hint')}</p>;
}

const SERVER_GAMES: [string, string][] = [['tmnf', 'Nations Forever'], ['tmuf', 'United Forever'], ['eswc', 'Nations ESWC'], ['tms', 'Sunrise'], ['tmo', 'Original']];

/** "Eigenen Server eintragen" with the hub login: the server goes straight into the hub's review queue. */
export function HubServerDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const [game, setGame] = useState('tmnf');
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [homepage, setHomepage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await hubRequest('POST', '/v1/servers', { game, address: address.trim(), name: name.trim(), homepage: homepage.trim() || null });
      hub.toast({ ok: true, message: t('hubLogin.server.sent') });
      onClose();
    } catch (e) {
      const c = String(e);
      setErr(c.includes(':exists') ? t('hubLogin.server.exists') : c.includes('bad_address') ? t('hubLogin.server.badAddress') : c === 'unreachable' ? t('hubLogin.unreachable') : t('hubLogin.server.failed', { code: c }));
    } finally { setBusy(false); }
  };
  const ok = address.trim().length >= 3 && name.trim().length >= 3 && (!homepage.trim() || /^https:\/\/\S+$/i.test(homepage.trim()));
  return (
    <Modal title={t('hubLogin.server.title')} onClose={onClose} actions={<>
      <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn primary" disabled={!ok || busy} onClick={() => void send()}>{busy && <Loader2 size={14} className="spin" />} {t('hubLogin.server.send')}</button>
    </>}>
      <div className="hub-form">
        <label className="small dim">{t('hubLogin.server.game')}</label>
        <select className="text-in" value={game} onChange={(e) => setGame(e.target.value)}>{SERVER_GAMES.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
        <label className="small dim">{t('hubLogin.server.address')}</label>
        <input className="text-in mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="1.2.3.4:2350" spellCheck={false} maxLength={260} />
        <label className="small dim">{t('hubLogin.server.name')}</label>
        <input className="text-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <label className="small dim">{t('hubLogin.server.homepage')}</label>
        <input className="text-in" value={homepage} onChange={(e) => setHomepage(e.target.value)} placeholder="https://" spellCheck={false} maxLength={300} />
        <p className="small dim">{t('hubLogin.server.note')}</p>
        {err && <p className="small live-error">{err}</p>}
      </div>
    </Modal>
  );
}

/** Hub project of a catalog entry (imported entries keep their catalog id), when the index is loaded. */
function projectOf(entryId: string) {
  const pl = hubPayload();
  return pl?.projects.find((p) => p.catalogId === entryId || 'hub-' + p.slug === entryId) ?? null;
}

/** "Beanspruchen" on a mod page: only for hub projects that no author has claimed yet. */
export function HubClaimPanel({ entryId }: { entryId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const p = projectOf(entryId);
  if (!isNative || !p || p.claimed) return null;
  return (
    <section className="panel">
      <div className="dim small">{t('hubLogin.claim.question')}</div>
      <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>{t('hubLogin.claim.button')}</button>
      {open && <HubClaimDialog slug={p.slug} name={p.name} github={/github\.com\//i.test(p.links.source ?? '')} onClose={() => setOpen(false)} />}
    </section>
  );
}

function HubClaimDialog({ slug, name, github, onClose }: { slug: string; name: string; github: boolean; onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const s = useHubLogin();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const manual = async () => {
    setBusy(true);
    try {
      await hubRequest('POST', `/v1/projects/${encodeURIComponent(slug)}/claim`, { method: 'manual', message: msg.trim() || null });
      hub.toast({ ok: true, message: t('hubLogin.claim.sent') });
      onClose();
    } catch (e) {
      hub.toast({ ok: false, message: String(e) === 'unreachable' ? t('hubLogin.unreachable') : t('hubLogin.claim.failed', { code: String(e) }) });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={t('hubLogin.claim.title', { name })} onClose={onClose} actions={<button className="btn ghost" onClick={onClose}>{t('common.close')}</button>}>
      <p className="small">{t('hubLogin.claim.intro')}</p>
      {!canUseHub(s) ? (
        <>
          <p className="small dim">{t('hubLogin.claim.loginFirst')}</p>
          <BrandLoginButtons />
          <HubStatusLine s={s} />
        </>
      ) : (
        <div className="hub-form">
          {github && <BrandLoginButtons claim={slug} onDone={(c) => { if (c) onClose(); }} />}
          {github && <p className="small dim">{t('hubLogin.claim.githubTip')}</p>}
          <label className="small dim">{t('hubLogin.claim.message')}</label>
          <textarea className="text-in hub-textarea" value={msg} onChange={(e) => setMsg(e.target.value)} rows={3} maxLength={2000} />
          <div><button className="btn ghost sm" disabled={busy} onClick={() => void manual()}>{t('hubLogin.claim.manual')}</button></div>
        </div>
      )}
      <p className="small dim">{t('hubLogin.claim.discordNote')}</p>
    </Modal>
  );
}
