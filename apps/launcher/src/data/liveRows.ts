// Rows of the hub's own live server list (GET /v1/servers, read only), kept free of Tauri and the bundled
// hub data so it can be unit tested (liveRows.test.ts). Used by tmfServers.ts.
import type { GameServer } from '@tm-hub/shared';

export type LiveRow = GameServer & { title_: string | null };
const LIVE_GAMES = ['tmnf', 'tmuf', 'eswc'] as const;
type LiveGame = (typeof LIVE_GAMES)[number];
const LOGIN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Nations/United: servers that answered the hub's direct query, with a join link. ESWC: every listed entry (they
 * join by address, JoinGuide); players and mode when the hub's query reached it (`state: online`), otherwise
 * without live data (`online: null`; most ESWC entries have no address, see docs/hub/live-servers.md). Rows of
 * another game than these three are dropped. `titleOf` maps the hub game onto the launcher title id. */
export function liveRows(r: unknown, titleOf: (g: string) => string | null = (g) => g): LiveRow[] | null {
  if (!Array.isArray(r)) return null;
  const out: LiveRow[] = [];
  for (const x of r as Record<string, unknown>[]) {
    if (!x || typeof x.name !== 'string' || !x.name.trim()) continue;
    const game = (x.game === 'tmn-eswc' ? 'eswc' : x.game) as LiveGame;
    if (!LIVE_GAMES.includes(game)) continue;
    const eswc = game === 'eswc';
    const live = x.state === 'online';
    if (!eswc && !live) continue;
    const noLive = eswc && !live;
    const login = typeof x.login === 'string' && LOGIN.test(x.login) ? x.login : null;
    const address = typeof x.address === 'string' && x.address ? x.address : null;
    const num = (v: unknown) => Math.max(0, Number(v) || 0);
    out.push({
      id: `hub-poll:${game}:${login ?? address ?? x.name}`, source: 'hub-poll', sample: false, game, title: null,
      name: x.name, nameRaw: x.name, description: null, login,
      players: noLive ? 0 : num(x.players), maxPlayers: noLive ? 0 : num(x.maxPlayers), spectators: noLive || x.spectators == null ? null : num(x.spectators),
      zone: typeof x.country === 'string' ? x.country : null, mode: !noLive && typeof x.mode === 'string' ? x.mode : null,
      private: x.password === true, join: !eswc && login ? `tmtp://#join=${login}` : null, club: null,
      address, online: noLive ? null : true, lastSeen: typeof x.lastSeen === 'string' ? x.lastSeen : null,
      homepage: typeof x.homepage === 'string' ? x.homepage : null, title_: titleOf(game),
    });
  }
  return out;
}
