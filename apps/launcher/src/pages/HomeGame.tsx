// Home follows the selected game: its start panel (profile, active mods, warnings and the Play
// button), its events and its servers. Play on the hero opens this panel first unless
// "Start directly from Home" is on (Settings).
import { forwardRef, useEffect, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowRight, Play as PlayIcon, Server, Users } from 'lucide-react';
import { go, isTasProfile, useHubState } from '../state';
import { ModIcon, PlayButton, ProfileSelect, SectionHead, TmText } from '../ui/common';
import { communitiesFile, serversFile, upcomingEvents } from '../data/hub';
import { ExchangeEventCard, useExchangeEvents } from '../ui/ExchangeEvents';
import { backend } from '../data/backend';
import { useCachedImage } from '../ui/common';
import { HubEventRow } from './CommunityServices';
import { useT } from '../i18n';
import type { GameView } from '../data/types';
import type { GameId } from '@tm-hub/shared';
import { TmloaderSetupCard } from '../ui/TmloaderSetup';
import { liveFor, onTmfChange, refreshTmfServers, tmfState } from '../data/tmfServers';
import { GameChip } from '../ui/common';
import { JoinGuideButton, needsJoinGuide } from '../ui/JoinGuide';

/** Launcher game id -> hub data game id (events, servers). */
export function hubGame(id: string): GameId | null {
  const map: Record<string, GameId> = { 'tmn-eswc': 'eswc', 'tm-original': 'tmo', 'tm-sunrise': 'tms', 'tm-turbo': 'turbo' };
  return (map[id] ?? (/^(tmnf|tmuf|tm2020|tm2-canyon|tm2-stadium|tm2-valley|tm2-lagoon|sm-storm)$/.test(id) ? id : null)) as GameId | null;
}

/** The selected game's start panel: profile, what is switched on, warnings, Play. */
export const GameStartPanel = forwardRef<HTMLElement, { g: GameView; highlight?: boolean }>(function GameStartPanel({ g, highlight }, ref) {
  const hub = useHubState();
  const t = useT();
  const prof = hub.profileFor(g.id);
  const mods = (prof?.mods ?? []).map((pm) => hub.mods.find((m) => m.id === pm.id) ?? { id: pm.id, name: pm.id, icon: null });
  const updates = (prof?.mods ?? []).map((pm) => hub.mods.find((m) => m.id === pm.id)).filter((m) => m?.updateAvailable);
  const warnings: string[] = [];
  if (!g.installed) warnings.push(t('homeGame.notInstalled'));
  if (isTasProfile(prof)) warnings.push(t('homeGame.tasProfile'));
  if (updates.length) warnings.push(t('homeGame.updates', { mods: updates.map((m) => m!.name).join(', ') }));
  return (
    <section className={'panel game-start' + (highlight ? ' highlight' : '')} ref={ref}>
      <SectionHead title={t('homeGame.title', { game: g.short ?? g.name })} right={<button className="btn ghost sm" onClick={() => go('game', g.id)}>{t('home.gameDetails')} <ArrowRight size={14} /></button>} />
      <div className="gs-row">
        <ProfileSelect game={g} />
        <PlayButton game={g} size="sm" />
      </div>
      {g.modSystem !== 'None' && (
        <div className="gs-mods">
          {mods.length ? mods.map((m) => (
            <span className="gs-mod" key={m.id} title={m.name}><ModIcon mod={m} size={22} /><span className="ellip">{m.name}</span></span>
          )) : <span className="dim small">{t('homeGame.noMods')}</span>}
        </div>
      )}
      {warnings.map((w) => <p key={w} className="small warn gs-warn"><AlertTriangle size={13} /> {w}</p>)}
      {g.family === 'forever' && g.installed && <TmloaderSetupCard compact />}
    </section>
  );
});

/** Events and servers of the selected game (Home's left column). */
export function GameLive({ g }: { g: GameView }) {
  const hub = useHubState();
  const t = useT();
  const hg = hubGame(g.id);
  const events = upcomingEvents(hub.mode).filter((e) => hg && e.games.includes(hg));
  const xall = useExchangeEvents(g.id);
  const xevents = hub.mode === 'tas' ? [] : xall;
  // The hub's live list when it delivers (Launcher Preview: production hub, read only; United shows Nations servers
  // too), else the bundled list. Top 5 by players.
  const tmf = useSyncExternalStore(onTmfChange, tmfState);
  useEffect(() => { void refreshTmfServers(); }, []);
  const live = tmf.state === 'ok' ? liveFor(tmf.servers, g.id) : [];
  const servers = (live.length ? live : serversFile.servers.filter((s) => !s.sample && !s.private && hg && s.game === hg).sort((a, b) => b.players - a.players)).slice(0, 5);
  const mixed = g.id === 'tmuf';
  return (
    <section className="panel">
      <SectionHead title={t('homeGame.live', { game: g.short ?? g.name })} />
      <div className="events">
        {events.slice(0, 3).map((e) => <HubEventRow key={e.id} e={e} />)}
        {xevents.slice(0, 2).map((p) => <ExchangeEventCard key={p.id} p={p} compact />)}
        {events.length === 0 && xevents.length === 0 && <p className="dim small">{t('homeGame.noEvents')}</p>}
      </div>
      <div className="gs-servers">
        <div className="gs-sub"><Server size={14} /> {t('homeGame.servers')}</div>
        {servers.map((s) => (
          <div className="gs-server" key={s.id}>
            {mixed && s.game && <GameChip id={s.game} />}
            <TmText text={s.nameRaw} className="ellip grow" title={s.name} />
            {s.source === 'hub-poll' && s.online === null
              ? <span className="pill tiny muted">{t('servers.noLive')}</span>
              : <span className="dim small"><Users size={12} /> {s.players}/{s.maxPlayers}</span>}
            {s.join && hub.mode !== 'tas' && <button className="btn ghost sm" onClick={() => hub.play(g.id, s.join)}><PlayIcon size={13} /> {t('homeGame.join')}</button>}
            {!s.join && needsJoinGuide(g.id) && <JoinGuideButton game={g.id} name={s.name} address={s.address ?? null} />}
          </div>
        ))}
        {servers.length === 0 && <p className="dim small">{t('homeGame.noServers')}</p>}
        <button className="link-more" onClick={() => go('servers')}>{t('homeGame.allServers')} <ArrowRight size={13} /></button>
      </div>
    </section>
  );
}

/** Words that tie a Discord server to a game (the community sheet has no game column). */
const COMMUNITY_WORDS: Record<string, RegExp> = {
  tmnf: /\b(tmnf|tmuf|tmf|tmnf-x|tmuf-x|tmx|nations forever|united forever|trackmania forever)\b/i,
  tmuf: /\b(tmnf|tmuf|tmf|tmnf-x|tmuf-x|tmx|nations forever|united forever|trackmania forever)\b/i,
  'tmn-eswc': /\b(eswc|nations|tmn)\b/i,
  'tm-original': /\b(original|tmo|tm1|sunrise)\b/i,
  'tm-sunrise': /\b(sunrise|tms|original)\b/i,
  tm2020: /\b(tm2020|trackmania 2020|tmwt|cotd|club|nadeo)\b/i,
};
const TM2 = /\b(tm2|tm²|maniaplanet|canyon|valley|lagoon|stadium|shootmania|mania exchange)\b/i;

function CommAvatar({ icon, name }: { icon: string | null; name: string }) {
  const src = useCachedImage(icon);
  return src ? <img className="gs-ava" src={src} alt="" /> : <span className="gs-ava ph">{name.slice(0, 1).toUpperCase()}</span>;
}

/** A few Discord servers for the selected game, biggest first. */
export function GameCommunity({ g }: { g: GameView }) {
  const t = useT();
  const re = COMMUNITY_WORDS[g.id] ?? (g.id.startsWith('tm2-') || g.id === 'sm-storm' ? TM2 : null);
  const list = communitiesFile.communities
    .filter((c) => c.active !== false && c.alive !== false && c.invite && re && re.test([c.name, c.guildName ?? '', c.section].join(' ')))
    .filter((c, i, all) => all.findIndex((x) => (x.invite ?? x.url) === (c.invite ?? c.url)) === i)
    .sort((a, b) => (b.members ?? 0) - (a.members ?? 0))
    .slice(0, 5);
  return (
    <section className="panel">
      <SectionHead title={t('homeGame.community', { game: g.short ?? g.name })} />
      <div className="gs-comm">
        {list.map((c) => (
          <button className="gs-comm-row" key={c.id} onClick={() => backend.openExternal(c.url)} title={c.guildName ?? c.name}>
            <CommAvatar icon={c.icon ?? null} name={c.name} />
            <span className="ellip grow">{c.name}</span>
            {c.members != null && <span className="dim small"><Users size={12} /> {c.members}</span>}
          </button>
        ))}
        {list.length === 0 && <p className="dim small">{t('homeGame.noCommunity')}</p>}
      </div>
      <button className="link-more" onClick={() => go('community')}>{t('homeGame.allCommunity')} <ArrowRight size={13} /></button>
    </section>
  );
}
