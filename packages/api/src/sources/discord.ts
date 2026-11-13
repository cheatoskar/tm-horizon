// Community events from Discord scheduled events, read with a bot token:
//   GET https://discord.com/api/v10/guilds/{guild}/scheduled-events?with_user_count=true
//   (https://discord.com/developers/docs/resources/guild-scheduled-event)
// Only event fields are kept; creator ids and user lists are never read or written.
// Without DISCORD_BOT_TOKEN (set it as an environment variable / CI secret) or without guilds in the config
// this source is simply empty; there are no made-up events.
import type { HubEvent, SourceStatus } from '../types.ts';
import type { DiscordGuildConfig, SourceContext } from '../config.ts';
import { errorText, parseJoinLink, shorten } from '../lib/util.ts';

export interface DiscordScheduledEvent {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  status: number;
  entity_type: number;
  entity_metadata?: { location?: string } | null;
  user_count?: number;
  image?: string | null;
}

const STATUS: Record<number, string> = { 1: 'scheduled', 2: 'active', 3: 'completed', 4: 'canceled' };

export function parseDiscordEvents(raw: unknown, guild: DiscordGuildConfig): HubEvent[] {
  if (!Array.isArray(raw)) throw new Error('unexpected Discord response (not an array)');
  return (raw as DiscordScheduledEvent[]).map((e) => {
    const location = e.entity_metadata?.location?.trim() || null;
    return {
      id: `discord:${e.guild_id}:${e.id}`,
      source: 'discord' as const,
      sample: false,
      name: e.name,
      description: shorten(e.description?.trim(), 2000),
      start: new Date(e.scheduled_start_time).toISOString(),
      end: e.scheduled_end_time ? new Date(e.scheduled_end_time).toISOString() : null,
      status: STATUS[e.status] ?? 'scheduled',
      location,
      join: parseJoinLink(location) ?? parseJoinLink(e.description),
      community: { id: e.guild_id, name: guild.name, invite: guild.invite ?? null },
      interested: typeof e.user_count === 'number' ? e.user_count : null,
      image: e.image ? `https://cdn.discordapp.com/guild-events/${e.id}/${e.image}.png?size=512` : null,
      games: guild.games ?? [],
      url: `https://discord.com/events/${e.guild_id}/${e.id}`,
    };
  });
}

export async function buildEvents(ctx: SourceContext, now: Date): Promise<{ events: HubEvent[]; sources: SourceStatus[] }> {
  const token = ctx.env.DISCORD_BOT_TOKEN;
  const guilds = ctx.config.discord.guilds;
  if (!token || guilds.length === 0) {
    const why = !token ? 'DISCORD_BOT_TOKEN not set' : 'no guilds in config.discord.guilds';
    return { events: [], sources: [{ id: 'discord', ok: true, count: 0, sample: false, error: `${why}: Discord events off` }] };
  }
  const events: HubEvent[] = [];
  const sources: SourceStatus[] = [];
  for (const g of guilds) {
    const url = `https://discord.com/api/v10/guilds/${g.id}/scheduled-events?with_user_count=true`;
    try {
      const { data, result } = await ctx.http.getJson<unknown>(url, {
        ttlMinutes: ctx.config.discord.ttlMinutes,
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://github.com/cheatoskar, 0.1)' },
      });
      const got = parseDiscordEvents(data, g).filter((e) => e.status === 'scheduled' || e.status === 'active');
      events.push(...got);
      sources.push({ id: `discord:${g.id}`, ok: true, count: got.length, sample: false, cached: !!result.cache });
    } catch (e) {
      ctx.warn(`discord: ${g.name} (${g.id}): ${errorText(e)}`);
      sources.push({ id: `discord:${g.id}`, ok: false, count: 0, sample: false, error: errorText(e) });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, sources };
}
