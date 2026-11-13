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
