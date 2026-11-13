import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Info, Search } from 'lucide-react';
import { go, useHubState } from '../state';
import { GameChip, SectionHead, TmText } from '../ui/common';
import { SERVERS, serversFile, upcomingEvents } from '../data/hub';
import { timeAgo } from '../data/model';
import { onTmfChange, refreshTmfServers, tmfState } from '../data/tmfServers';
import { LiveServers } from '../ui/LiveServers';
import { QGAMES, type QGame } from '../data/serverQuery';
import { AddServerButton, HubEventRow, OwnerLinks, ServerAddress, ServerStatus, SubmitEventButton } from './CommunityServices';
import { useT } from '../i18n';
import { masterLine } from '../data/masterLine';
import { JoinGuideButton, needsJoinGuide } from '../ui/JoinGuide';
import { HostServers } from './HostServers';

const GAME_FILTERS = [
  { id: 'all', label: '' },
  { id: 'tmnf', label: 'Nations' },
  { id: 'tmuf', label: 'United' },
  { id: 'tmn-eswc', label: 'ESWC' },
  { id: 'tm2', label: 'TM² / SM' },
  { id: 'tm2020', label: 'Trackmania' },
];
// Which games of the live list (game query) a chip of the filter row shows.
const LIVE_GAMES: Record<string, QGame[]> = { all: QGAMES, tmnf: ['tmnf'], tmuf: ['tmuf'], 'tmn-eswc': ['eswc'] };
const match = (f: string, game: string) => f === 'all' || game === f || (f === 'tm2' && (game.startsWith('tm2-') || game === 'sm-storm'));

/** Servers page: the public list, or "Eigener Server" (#/servers/host). */
export function Servers() {
  const { route } = useHubState();
  const t = useT();
  const own = route.arg === 'host';
  return (
    <>
      <div className="hs-tabs seg">
        <button className={!own ? 'on' : ''} onClick={() => go('servers')}>{t('host.tabList')}</button>
        <button className={own ? 'on' : ''} onClick={() => go('servers', 'host')}>{t('host.tabOwn')}</button>
      </div>
      {own ? <div className="page wide"><HostServers /></div> : <ServerList />}
    </>
  );
}

function ServerList() {
  const hub = useHubState();
  const t = useT();
  const events = upcomingEvents(hub.mode);
  const [f, setF] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'players' | 'name' | 'game'>('players');
  const tmf = useSyncExternalStore(onTmfChange, tmfState);
  useEffect(() => { void refreshTmfServers(); }, []);
  // With the hub source on and the hub delivering, its live list replaces the bundled TMNF/TMUF entries (community entries stay).
  const live = tmf.state === 'ok';
  // Entries the bundled list already has (same address, e.g. ESWC community servers) are not doubled.
  const known = new Set(SERVERS.map((s) => s.address).filter(Boolean));
  const base = live ? SERVERS.filter((s) => s.source === 'community' || (s.game !== 'tmnf' && s.game !== 'tmuf')).concat(tmf.servers.filter((s) => !s.address || !known.has(s.address) || s.game !== 'eswc')) : SERVERS;
  const all = base.filter((s) => !s.private && !s.sample);
  const rows = useMemo(() => all
    // United Forever joins Nations servers: the United chip shows them too.
    .filter((s) => (f === 'all' || (s.title_ ? match(f, s.title_) || (f === 'tmuf' && s.title_ === 'tmnf') : f === 'tm2')) && (!q || (s.name + ' ' + (s.mode ?? '') + ' ' + (s.club?.name ?? '')).toLowerCase().includes(q.toLowerCase())))
    .sort((x, y) => {
      const byPlayers = Number(y.source === 'community') - Number(x.source === 'community') || y.players - x.players;
      const byName = x.name.localeCompare(y.name, undefined, { sensitivity: 'base' });
      if (sort === 'name') return byName || byPlayers;
      if (sort === 'game') return (x.title_ ?? '').localeCompare(y.title_ ?? '') || byPlayers;
      return byPlayers || byName;
    }), [f, q, all, sort]);
  const players = all.reduce((n, s) => n + s.players, 0);
  const masters = serversFile.masterServers ?? [];
  // ESWC servers in the list below (hub polls, often without live data): the master line must not read as "none".
  const eswcKnown = all.filter((s) => s.game === 'eswc').length;
  const foreverRows = all.filter((s) => s.game === 'tmnf' || s.game === 'tmuf');
  const forever = serversFile.notAvailable.find((n) => n.game === 'forever');
  const zone = (z: string | null) => (z ? z.split('|').slice(-2).join(' · ') : '-');
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t('nav.servers')}</h1>
          <span className="dim">{t('servers.sub', { n: all.length, players, ago: timeAgo(serversFile.generated) })}</span>
          {tmf.state === 'ok' && <span className="dim small"> · {t('servers.viaHub', { ago: tmf.fetchedAt ? timeAgo(tmf.fetchedAt) : '-' })}{tmf.stale ? ' · ' + t('servers.viaHubStale') : ''}</span>}
          {tmf.state === 'fallback' && <span className="dim small"> · {t('servers.hubOff')}</span>}
        </div>
      </div>

      <div className="toolbar srv-toolbar">
        <label className="search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('servers.search')} />
        </label>
        <div className="chips">
          {GAME_FILTERS.map((x) => <button key={x.id} className={'fchip' + (f === x.id ? ' on' : '')} onClick={() => setF(x.id)}>{x.label || t('common.all')}</button>)}
        </div>
        <label className="select">
          <span className="dim small">{t('mods.sort')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="players">{t('servers.colPlayers')}</option>
            <option value="name">{t('servers.colServer')}</option>
            <option value="game">{t('servers.colGame')}</option>
          </select>
        </label>
        <AddServerButton />
      </div>
      {forever && (f === 'all' || f === 'tmnf' || f === 'tmuf' || f === 'tmn-eswc') && (
        <div className="notice slim">
          <Info size={16} />
          <div className="small">{foreverRows.length ? t('server.foreverNote') : t('server.foreverEmpty')}</div>
        </div>
      )}
      {masters.length > 0 && (f === 'all' || f === 'tmn-eswc') && (
        <div className="live-masters">
          {masters.map((m) => (
            <div className="live-master" key={m.id}>
              <GameChip id="tmn-eswc" />
              <b>{m.name}</b>
              <span className="dim small">{m.level ? m.level + ' · ' : ''}{(({ key, vars }) => t(key, vars))(masterLine(m.players, m.servers, eswcKnown))}</span>
            </div>
          ))}
        </div>
      )}

      {LIVE_GAMES[f] && <LiveServers games={LIVE_GAMES[f]} q={q} sort={sort} />}

      <div className="table">
        <div className="tr th">
          <span>{t('servers.colServer')}</span><span>{t('servers.colGame')}</span><span>{t('servers.colMode')}</span><span>{t('servers.colZone')}</span><span>{t('servers.colPlayers')}</span><span />
        </div>
        {rows.map((s) => {
          // A Nations server is joined with United Forever when that is the game at hand (United chip, or Nations not installed).
          const own = s.title_ ? hub.game(s.title_) : null;
          const viaUnited = s.title_ === 'tmnf' && (f === 'tmuf' || (!own?.installed && hub.game('tmuf')?.installed));
          const g = viaUnited ? hub.game('tmuf') : own;
          const installed = g ? g.installed : hub.games.some((x) => x.family === 'maniaplanet' && x.installed);
          const community = s.source === 'community';
          const noLive = s.source === 'hub-poll' && s.online === null;
          const full = !community && !noLive && s.players >= s.maxPlayers;
          const tip = !installed ? t('play.gameMissing') : full ? t('servers.full') : s.join ? t('servers.opens', { join: s.join }) : s.club ? t('servers.startsClub', { club: s.club.name }) : t('servers.starts');
          return (
            <div className="tr" key={s.id}>
              <span className="srv">
                <TmText text={s.nameRaw} className="ellip" title={s.name} />
                <span className="dim small ellip">
                  {community && <span className="pill tiny">{t('server.community')}</span>}
                  {s.club ? t('servers.club', { name: s.club.name }) : s.login} <ServerAddress s={s} /> {community && <OwnerLinks s={s} />}
                </span>
              </span>
              <span>{own ? <GameChip id={own.id} /> : <span className="chip" title={s.title ?? ''}>{(s.title ?? t('servers.custom')).split('@')[0]}</span>}</span>
              <span className="dim ellip" title={s.mode ?? ''}>{s.mode ?? '-'}</span>
              <span className="dim small ellip" title={s.zone ?? ''}>{zone(s.zone)}</span>
              {noLive
                ? <span className="players"><span className="pill tiny muted">{t('servers.noLive')}</span></span>
                : community
                ? <span className="players"><ServerStatus s={s} /></span>
                : <span className="players">
                    <span className="bar"><i style={{ width: `${Math.min(100, (s.players / Math.max(1, s.maxPlayers)) * 100)}%` }} /></span>
                    <span className="small nowrap">{s.players}/{s.maxPlayers}</span>
                  </span>}
              <span>
                {!s.join && g && needsJoinGuide(g.id)
                  ? <JoinGuideButton game={g.id} name={s.name} address={s.address ?? null} primary />
                  : (s.join || !community) && <button className="btn primary sm" disabled={!installed || full} title={tip}
                  onClick={() => (g ? hub.play(g.id, s.join) : hub.toast({ message: t('common.previewOpen'), command: s.join ?? '' }))}>
                  {t('event.join')}
                </button>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Events below the servers; Exchange news posts belong on the News page, not here. */}
      <SectionHead title={t('event.title')} sub={t('event.sub')} right={<SubmitEventButton />} />
      <div className="events row4">
        {events.slice(0, 8).map((e) => <HubEventRow key={e.id} e={e} />)}
        {events.length === 0 && <div className="dim small">{t('event.none')}</div>}
      </div>
    </div>
  );
}

