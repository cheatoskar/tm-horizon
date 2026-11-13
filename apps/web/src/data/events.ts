// SAMPLE DATA. Times are generated relative to the build time so the page always shows one live and several upcoming events.
// Later source: Discord scheduled events (a bot in each community's Discord) and TMX. Shape of one event:
//   { id, title, kind, game, host, start (ISO, UTC), minutes, join (tmtp:// link or null), source: 'discord' | 'tmx', sourceId, note }
// The bot would map a Discord scheduled event to this: name -> title, scheduled_start_time -> start,
// scheduled_end_time - start -> minutes, entity_metadata.location -> join, guild name -> host, id -> sourceId.
export interface TmEvent {
  id: string;
  title: string;
  kind: 'Cup' | 'RMC' | 'Server night' | 'Campaign' | 'Meetup';
  game: string;
  host: string;
  start: string;
  minutes: number;
  join: string | null;
  source: 'discord' | 'tmx';
  sourceId: string;
  note: string;
}

const base = Date.now();
const at = (hours: number) => new Date(Math.round((base + hours * 3600_000) / 60_000) * 60_000).toISOString();

export const sampleEvents: TmEvent[] = [
  { id: 'ev1', title: 'Friday Fullspeed Night', kind: 'Server night', game: 'tmnf', host: 'Fullspeed', start: at(-0.5), minutes: 180, join: 'tmtp://#join=sample-fullspeed-night', source: 'discord', sourceId: '000000000000000001', note: 'Fullspeed maps, 5 minute rounds. Sample.' },
  { id: 'ev2', title: 'Random Map Challenge, 1 hour', kind: 'RMC', game: 'tmnf', host: 'TMNF Community', start: at(3), minutes: 90, join: 'tmtp://#join=sample-rmc', source: 'discord', sourceId: '000000000000000002', note: 'Random maps from TMX, author medal or skip. Sample.' },
  { id: 'ev3', title: 'Stadium Sprint Cup, round 2', kind: 'Cup', game: 'tm2-stadium', host: 'ManiaPlanet Community', start: at(20), minutes: 120, join: 'tmtp://#join=sample-sprint', source: 'discord', sourceId: '000000000000000003', note: 'Qualifier for 64 players. Sample.' },
  { id: 'ev4', title: 'Weekly Shorts', kind: 'Campaign', game: 'tm2020', host: 'Weekly Shorts', start: at(29), minutes: 60, join: null, source: 'tmx', sourceId: 'tmx-weekly-0000', note: 'New map pack, no server. Sample.' },
  { id: 'ev5', title: 'Editor Night: build together', kind: 'Meetup', game: 'tmuf', host: 'TMUnlimiter', start: at(52), minutes: 120, join: null, source: 'discord', sourceId: '000000000000000005', note: 'Voice call, share screen. Sample.' },
  { id: 'ev6', title: 'TMNF Open Cup', kind: 'Cup', game: 'tmnf', host: 'TMNF Community', start: at(76), minutes: 150, join: 'tmtp://#join=sample-open-cup', source: 'discord', sourceId: '000000000000000006', note: 'Open to everyone, 10 maps. Sample.' },
];
