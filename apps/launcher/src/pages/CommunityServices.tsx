// Community services from the hub data (packages/api): events (Discord, submitted through the
// GitHub issue form, or samples while there is nothing real) and community-registered servers
// (online / last seen, address with a copy button for games that join by address).
import { CalendarClock, CalendarPlus, Copy, ExternalLink, Radio, ServerCog } from 'lucide-react';
import { backend } from '../data/backend';
import { ADDRESS_GAMES, eventFields, serverFields, titleOf, type GameServer, type HubEvent } from '../data/hub';
import { useHubState } from '../state';
import { GameChip } from '../ui/common';
import { useIssueForm } from '../ui/RepoDialog';
import { useState } from 'react';
import { canUseHub, useHubLogin } from '../data/hubAuth';
import { HubLoginHint, HubServerDialog } from '../ui/HubAccount';
import { ago, fmtDateTime, useT } from '../i18n';
import { JoinGuideButton, needsJoinGuide } from '../ui/JoinGuide';

const art = (e: HubEvent) => ['news-2', 'news-4', 'news-3', 'news-1'][Math.abs([...e.id].reduce((a, c) => a + c.charCodeAt(0), 0)) % 4];
const domain = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
const safeLink = (u: string | null | undefined) => (u && /^https:\/\//i.test(u) ? u : null);

export function copyText(text: string, done: () => void) {
  navigator.clipboard?.writeText(text).then(done).catch(() => {});
}

export function HubEventRow({ e }: { e: HubEvent }) {
  const hub = useHubState();
  const t = useT();
  const gid = titleOf(e.games[0] ?? null);
  const g = gid ? hub.games.find((x) => x.id === gid) : undefined;
  const start = Date.parse(e.start);
  const end = e.end ? Date.parse(e.end) : start + 2 * 3600_000;
  const live = start <= Date.now() && Date.now() < end;
  const mins = Math.max(0, Math.round((start - Date.now()) / 60000));
  const soon = mins < 60 ? t('event.inMin', { n: mins }) : mins < 1440 ? t('event.inH', { n: Math.round(mins / 60) }) : fmtDateTime(e.start);
  const link = safeLink(e.url) ?? safeLink(e.community?.invite);
  return (
    <div className={'event' + (live ? ' live' : '')}>
      <div className="event-art">{e.image ? <img src={e.image} alt="" loading="lazy" /> : <img src={`art/${art(e)}-card.jpg`} alt="" loading="lazy" />}</div>
      <div className="event-body">
        <div className="event-top">
          {live ? <span className="live-pill"><Radio size={12} /> {t('event.live')}</span> : <span className="soon-pill"><CalendarClock size={12} /> {soon}</span>}
          {g && <GameChip id={g.id} />}
          <span className={'pill tiny ' + (e.sample ? 'sample-pill' : 'muted')}>{t('event.src.' + e.source)}</span>
        </div>
        <b className="event-name" title={e.description || e.name}>{e.name}</b>
        <span className="dim small ellip" title={(e.community?.name ? t('event.by', { host: e.community.name }) : '') + (e.address ? ` · ${e.address}` : '')}>{e.community?.name ? t('event.by', { host: e.community.name }) : ''}{e.address ? ` · ${e.address}` : ''}</span>
      </div>
      {e.join && g ? (
        <button className={'btn ' + (live ? 'primary' : 'ghost') + ' sm'} disabled={!g.installed} title={g.installed ? e.join.raw : t('common.notInstalled')} onClick={() => hub.play(g.id, e.join!.raw)}>{t('event.join')}</button>
      ) : e.address && g && needsJoinGuide(g.id) ? (
        <JoinGuideButton game={g.id} name={e.name} address={e.address} primary={live} />
      ) : e.address ? (
        <button className="btn ghost sm" title={t('server.copyTip')} onClick={() => copyText(e.address!, () => hub.toast({ message: t('server.copied', { address: e.address! }) }))}><Copy size={13} /> {t('common.copy')}</button>
      ) : link ? (
        <button className="btn ghost sm" title={link} onClick={() => backend.openExternal(link)}><ExternalLink size={13} /> {t('common.open')}</button>
      ) : null}
    </div>
  );
}

export function SubmitEventButton() {
  if (__RELEASE_PREVIEW__) return null;
  return <SubmitEventForm />;
}

function SubmitEventForm() {
  const t = useT();
  const form = useIssueForm('event', eventFields);
  return <><button className="btn ghost sm" title={t('community.checkedByHand')} onClick={form.start}><CalendarPlus size={14} /> {t('event.submit')}</button>{form.dialog}</>;
}

export function AddServerButton() {
  // Launcher Preview: no server registration (neither through the hub nor the issue form).
  if (__RELEASE_PREVIEW__) return null;
  return <AddServerForm />;
}

function AddServerForm() {
  const t = useT();
  // Logged in to a reachable hub: straight into the hub's review queue; otherwise the issue text as before.
  const login = useHubLogin();
  const direct = canUseHub(login);
  const [hubDlg, setHubDlg] = useState(false);
  const form = useIssueForm('server', serverFields, <HubLoginHint />);
  return <>
    <button className="btn ghost sm" title={t('community.checkedByHand')} onClick={direct ? () => setHubDlg(true) : form.start}><ServerCog size={14} /> {t('server.add')}</button>
    {direct ? hubDlg && <HubServerDialog onClose={() => setHubDlg(false)} /> : form.dialog}
  </>;
}

/** Status of a community server: online / last seen / not checked. */
export function ServerStatus({ s }: { s: GameServer }) {
  const t = useT();
  if (s.online === true) return <span className="small"><span className="dot on" /> {t('server.online')}</span>;
  if (s.online === false) return <span className="small dim"><span className="dot" /> {s.lastSeen ? t('server.lastSeen', { ago: ago(s.lastSeen) }) : t('server.offline')}</span>;
  return <span className="small dim">{t('server.notChecked')}</span>;
}

/** Address with a copy button, for games that join by address (ESWC, Sunrise, Original) or have no join link. */
export function ServerAddress({ s }: { s: GameServer }) {
  const hub = useHubState();
  const t = useT();
  if (!s.address || s.join) return null;
  return (
    <span className="addr">
      <code className="mono small">{s.address}</code>
      <button className="btn icon tiny" title={ADDRESS_GAMES.includes(s.game ?? '') ? t('server.addressTip') : t('common.copy')}
        onClick={() => copyText(s.address!, () => hub.toast({ message: t('server.copied', { address: s.address! }) }))}><Copy size={12} /></button>
    </span>
  );
}

export function OwnerLinks({ s }: { s: GameServer }) {
  const links = [safeLink(s.homepage), safeLink(s.contact)].filter((x): x is string => !!x);
  if (!links.length) return null;
  return <>{links.map((u) => <button key={u} className="linkish small" title={u} onClick={() => backend.openExternal(u)}>{domain(u)}</button>)}</>;
}
