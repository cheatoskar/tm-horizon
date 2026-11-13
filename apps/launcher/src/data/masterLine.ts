// The line under a master server on the Servers page (ESWC). A master that lists 0 servers while the list below
// has known servers (hub polls without live data) must not read as "no servers": it says so instead.

export interface MasterLine { key: string; vars: Record<string, number> }

/** `players`/`servers` from the master server, `known` = the game's servers in the list below. */
export function masterLine(players: number, servers: number, known: number): MasterLine {
  if (servers === 0 && players === 0 && known > 0) return { key: 'v052.masterNone', vars: { n: known } };
  return { key: 'server.masterCounts', vars: { players, servers } };
}
