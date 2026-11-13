// "Eigener Server": the player's own game servers. Rust side: src-tauri/src/hosting/ (commands in
// hosting/app.rs). In the browser preview a small in-memory sample stands in (no process, no network).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend } from './backend';

export interface Package { id: string; url: string; sha256: string; size: number; note: string }
export interface Kind {
  id: string; label: string; status: 'built' | 'experimental' | 'later'; package: Package | null;
  mapExt: string; loginForLan: boolean; loginForInternet: boolean; loginPage: string | null;
  query: string | null; tmx: string | null; engines: string[]; matchStyle: 'legacy' | 'script'; cfgStyle: string; reason: string;
}
export interface Ports { game: number; p2p: number; xmlrpc: number }
export type MapRef = { kind: 'file'; path: string; name: string } | { kind: 'tmx'; id: number; name: string };
export interface Match { mode: string; timeLimitS: number; pointsLimit: number; rounds: number; laps: number; chatTimeS: number; randomOrder: boolean; newRules: boolean }
export interface ServerDef {
  id: string; game: string; engine: string; name: string; comment: string; password: string; specPassword: string;
  maxPlayers: number; maxSpectators: number; internet: boolean; ports: Ports; maps: MapRef[]; match: Match;
  guests: string[]; blacklist: string[]; admins: string[]; serverLogin: string; validationKey: string;
  randomizer: { preset: string; autoSkip: string; timeLimitMin: number; webPort: number };
  upnp: boolean; autostart: boolean;
  listing: { consentAt: string | null; hubId: string | null; address: string | null; hasToken: boolean };
  created: string;
}
export interface Upnp { ok: boolean; mapped: string[]; externalIp: string | null; error: string | null; detail: string | null; serverFallback?: boolean }
export interface RunInfo { state: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'failed'; step: string | null; error: string | null; started: number | null; upnp: Upnp | null; portsMovedFrom?: number | null }
export interface ServerRow { def: ServerDef; run: RunInfo; leftover: boolean; hasAccount: boolean; hasToken: boolean; dropped?: string[] }
export interface Overview { kinds: Kind[]; servers: ServerRow[]; randomizerRepo: string; platform: string }
export interface Player { login: string; nick: string; spectator: boolean; ladder: number }
export interface LiveStatus { status: string; players: Player[]; spectators: number; maxPlayers: number; map: string | null; mode: string | null; guests: string[]; blacklist: string[]; bans: string[] }
/** Header facts of a map file (src-tauri hosting/mapfiles.rs). */
export interface MapMeta {
  path: string; name: string; folder: string; author: string; environment: string;
  authorTime: number | null; validated: boolean; uid: string; hasThumb: boolean;
}
export type LocalMap = MapMeta;
export interface Picked { maps: MapMeta[]; skipped: string[] }
export interface TmxHit { id: number; name: string; author: string; authorTime: number | null; environment: string; thumb: string | null }
export interface TmxPreview { kind: 'map' | 'pack' | 'search' | 'name'; title: string | null; owner: string | null; hits: TmxHit[]; more: boolean }
export interface TmxAddResult { added: { id: number; name: string }[]; failed: { id: number; reason: string }[] }
export interface SeenPlayer { login: string; nick: string; firstSeen: number; lastSeen: number; visits: number }
export interface ConsoleMap { name: string; file: string; author: string; environment: string }
export interface ConsoleState {
  live: LiveStatus; chat: string[]; maps: ConsoleMap[]; current: number | null; next: number | null;
  timeLimitS: number | null; nextTimeLimitS: number | null; canPause: boolean; script: boolean;
}
export type ConsoleAction = 'kick' | 'ban' | 'unban' | 'guest' | 'unguest' | 'spec' | 'play' | 'chat' | 'next' | 'restart' | 'jump' | 'timelimit' | 'pause' | 'resume';
export interface ConsoleCmd { action: ConsoleAction; login?: string; text?: string; value?: number }
export interface Reach { verdict: 'reachable' | 'cgnat' | 'router' | 'firewall' | 'upnp-off' | 'hub'; publicIp: string | null; tcp: string | null; detail: string | null }
export interface FirewallInfo { supported: boolean; exists: boolean; command: string }

const native = () => backend.kind === 'native';

/** Presets of the 100% TMX server per game (its README, 2026-11-11). */
export const RANDOMIZER_PRESETS: Record<string, string[]> = {
  tmnf: ['100tmx_tmnf', 'short_lol_tmnf', 'lunatic_tmnf', 'rpg_tmnf', 'fullspeed_tmnf', 'tech_tmnf', 'multilap_tmnf'],
  tmuf: ['100tmx_tmuf', '100tmx_tmuf_snow', '100tmx_tmuf_desert', '100tmx_tmuf_rally', '100tmx_tmuf_island', '100tmx_tmuf_coast', '100tmx_tmuf_bay', '100tmx_tmuf_stadium', 'short_lol_tmuf', 'lunatic_tmuf', 'rpg_tmuf', 'fullspeed_tmuf', 'tech_tmuf', 'multilap_tmuf'],
  eswc: ['100tmx_tmn', 'short_lol_tmn', 'lunatic_tmn', 'fullspeed_tmn', 'tech_tmn'],
  tms: [], tmo: [],
};
export const AUTO_SKIP = ['AuthorMedal', 'GoldMedal', 'SilverMedal', 'BronzeMedal', 'Finished', 'None'];
export const MODES_LEGACY = ['ta', 'rounds', 'team', 'laps', 'cup', 'stunts'];
export const MODES_SCRIPT = ['ta', 'rounds', 'team', 'laps', 'cup'];

// ------------------------------------------------------------------ preview sample (browser only)

const sampleDef = (over: Partial<ServerDef>): ServerDef => ({
  id: 'sample', game: 'tmnf', engine: 'plain', name: '', comment: '', password: '', specPassword: '', maxPlayers: 16, maxSpectators: 8, internet: false,
  ports: { game: 2350, p2p: 3450, xmlrpc: 5000 }, maps: [], match: { mode: 'ta', timeLimitS: 300, pointsLimit: 50, rounds: 5, laps: 5, chatTimeS: 10, randomOrder: false, newRules: false },
  guests: [], blacklist: [], admins: [], serverLogin: '', validationKey: '', randomizer: { preset: '', autoSkip: 'AuthorMedal', timeLimitMin: 0, webPort: 8090 },
  upnp: false, autostart: false, listing: { consentAt: null, hubId: null, address: null, hasToken: false }, created: '1', ...over,
});
const K = (id: string, label: string, status: Kind['status'], engines: string[], extra: Partial<Kind> = {}): Kind => ({
  id, label, status, package: { id, url: '', sha256: 'x'.repeat(64), size: 13075571, note: '' }, mapExt: '.Challenge.Gbx', loginForLan: false, loginForInternet: true, loginPage: null,
  query: id, tmx: null, engines, matchStyle: 'legacy', cfgStyle: 'forever', reason: '', ...extra,
});
let sample: Overview = {
  platform: 'windows', randomizerRepo: 'cheatoskar/100-TMX-Server',
  kinds: [
    K('tmnf', 'TrackMania Nations Forever', 'built', ['plain', 'randomizer', 'xaseco'], { tmx: 'tmnf.exchange' }),
    K('tmuf', 'TrackMania United Forever', 'built', ['plain', 'randomizer', 'xaseco'], { tmx: 'tmuf.exchange' }),
    K('eswc', 'TrackMania Nations ESWC', 'experimental', ['plain', 'randomizer']),
    K('tms', 'TrackMania Sunrise', 'experimental', ['plain', 'randomizer']),
    K('tmo', 'TrackMania Original', 'experimental', ['plain', 'randomizer']),
    K('tm2', 'TrackMania² (ManiaPlanet)', 'experimental', ['plain'], { matchStyle: 'script', mapExt: '.Map.Gbx', query: null, loginPage: 'https://www.maniaplanet.com/account/dedicated-servers', tmx: 'tm.mania.exchange' }),
    K('tm2020', 'Trackmania', 'experimental', ['plain'], { matchStyle: 'script', mapExt: '.Map.Gbx', query: null, loginForLan: true, loginPage: 'https://www.trackmania.com/player/dedicated-servers', tmx: 'trackmania.exchange' }),
  ],
  servers: [
    {
      def: sampleDef({ id: 'sa1', name: '$s$0bfMy $fffTMNF $f80Server', comment: 'Friday fun, $oall welcome', internet: true, upnp: true, serverLogin: 'myserver', guests: ['buddy', 'teammate'], maps: [{ kind: 'tmx', id: 123, name: 'A01-Race' }, { kind: 'tmx', id: 456, name: 'Speed' }] }),
      run: { state: 'running', step: null, error: null, started: Math.floor(Date.now() / 1000) - 3700, upnp: { ok: true, mapped: ['TCP:2350', 'UDP:2350', 'TCP:3450', 'UDP:3450'], externalIp: '85.10.20.30', error: null, detail: null } },
      leftover: false, hasAccount: true, hasToken: false,
    },
    {
      def: sampleDef({ id: 'sa2', game: 'tmuf', engine: 'randomizer', name: '$f00Random $fffMaps', ports: { game: 2351, p2p: 3451, xmlrpc: 5001 }, randomizer: { preset: '100tmx_tmuf', autoSkip: 'AuthorMedal', timeLimitMin: 0, webPort: 8091 } }),
      run: { state: 'stopped', step: null, error: null, started: null, upnp: null }, leftover: false, hasAccount: false, hasToken: false,
    },
  ],
};
const sampleStatus: LiveStatus = {
  status: 'Running - Play', spectators: 1, maxPlayers: 16, map: '$fffA01-$f00Race', mode: 'TimeAttack', guests: ['buddy', 'teammate'], blacklist: [], bans: [],
  players: [
    { login: 'speedy', nick: '$f80Speedy$fff Gonzales', spectator: false, ladder: 1234 },
    { login: 'tmfan', nick: '$0f0TM$fffFan', spectator: false, ladder: 20511 },
    { login: 'watcher', nick: 'Watcher', spectator: true, ladder: -1 },
  ],
};
const sampleMaps: MapMeta[] = [
  ['A01-Race', '$fffA01-$f00Race', 'Nadeo', 'Campaigns', 23450], ['A02-Race', '$fffA02-$f00Race', 'Nadeo', 'Campaigns', 25110], ['B05-Race', '$fffB05-$f80Race', 'Nadeo', 'Campaigns', 33010],
  ['My Speed Map', '$s$0bfMy $fffSpeed Map', 'me', 'My Challenges', 41280], ['Tech Tour', '$o$0f0Tech$z Tour', 'tmfan', 'My Challenges', 58730], ['Template', 'Template', 'me', 'My Challenges', null],
  ['Fullspeed Friday', '$f00Full$fffspeed $f00Friday', 'speedy', 'Downloaded', 36500], ['Lappen Loop', 'Lappen Loop', 'lappen', 'Downloaded', 61020],
].map(([f, n, a, folder, at]) => ({ path: `C:/sample/${folder}/${f}.Challenge.Gbx`, name: n as string, folder: folder as string, author: a as string, environment: 'Stadium', authorTime: at as number | null, validated: at !== null, uid: 'u' + f, hasThumb: false }));
const sampleConsole: ConsoleState = {
  live: sampleStatus, script: false, canPause: false, current: 0, next: 1, timeLimitS: 300, nextTimeLimitS: 300,
  chat: ['$z[$f80Speedy$fff Gonzales$z] gl hf', '$z[$0f0TM$fffFan$z] that last cp is mean', '$z[$00fWatcher$z] 52.93 :)'],
  maps: [{ name: '$fffA01-$f00Race', file: 'A01.Challenge.Gbx', author: 'Nadeo', environment: 'Stadium' }, { name: '$0bfSpeed$fff Run', file: 'b.Challenge.Gbx', author: 'speedy', environment: 'Stadium' }, { name: 'Tech Tour', file: 'c.Challenge.Gbx', author: 'tmfan', environment: 'Stadium' }],
};
const sampleSeen: SeenPlayer[] = [
  { login: 'speedy', nick: '$f80Speedy$fff Gonzales', firstSeen: 1, lastSeen: Math.floor(Date.now() / 1000) - 60, visits: 4 },
  { login: 'tmfan', nick: '$0f0TM$fffFan', firstSeen: 1, lastSeen: Math.floor(Date.now() / 1000) - 3600, visits: 2 },
  { login: 'nightdriver', nick: '$00fNight$fffDriver', firstSeen: 1, lastSeen: Math.floor(Date.now() / 1000) - 86400 * 2, visits: 1 },
];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

// ------------------------------------------------------------------ API

export const host = {
  async overview(): Promise<Overview> {
    if (!native()) return structuredClone(sample);
    return invoke<Overview>('host_overview');
  },
  async create(game: string): Promise<ServerDef> {
    if (!native()) {
      const used = sample.servers.map((s) => s.def.ports.game);
      let g = 2350; while (used.includes(g)) g++;
      return sampleDef({ id: 's' + Math.random().toString(16).slice(2, 10), game, created: String(Date.now()), ports: { game: g, p2p: g + 1100, xmlrpc: 5000 + (g - 2350) } });
    }
    return invoke<ServerDef>('host_new', { game });
  },
  async save(def: ServerDef, secrets?: { account?: string; hubToken?: string }): Promise<ServerDef> {
    if (!native()) {
      const i = sample.servers.findIndex((s) => s.def.id === def.id);
      const row: ServerRow = { def, run: i >= 0 ? sample.servers[i].run : { state: 'stopped', step: null, error: null, started: null, upnp: null }, leftover: false, hasAccount: !!secrets?.account || (i >= 0 && sample.servers[i].hasAccount), hasToken: false };
      if (i >= 0) sample.servers[i] = row; else sample.servers.push(row);
      changed();
      return def;
    }
    return invoke<ServerDef>('host_save', { def, secretsIn: secrets ?? null });
  },
  async remove(id: string) { if (!native()) { sample.servers = sample.servers.filter((s) => s.def.id !== id); changed(); return; } await invoke('host_delete', { id }); },
  async start(id: string) {
    if (!native()) { const s = sample.servers.find((x) => x.def.id === id); if (s) s.run = { ...s.run, state: 'running', started: Math.floor(Date.now() / 1000) }; changed(); return; }
    await invoke('host_start', { id });
  },
  async stop(id: string) {
    if (!native()) { const s = sample.servers.find((x) => x.def.id === id); if (s) s.run = { state: 'stopped', step: null, error: null, started: null, upnp: null }; changed(); return; }
    await invoke('host_stop', { id });
  },
  async status(id: string): Promise<LiveStatus> { return native() ? invoke<LiveStatus>('host_status', { id }) : structuredClone(sampleStatus); },
  async player(id: string, action: 'kick' | 'ban' | 'unban' | 'guest' | 'unguest', login: string) { if (native()) await invoke('host_player', { id, action, login }); },
  async log(id: string): Promise<string> { return native() ? invoke<string>('host_log', { id }) : '[preview] TrackmaniaServer started\nListening on 2350 / 3450\nXML-RPC on 127.0.0.1:5000\n'; },
  async leftover(id: string, action: 'stop' | 'forget') { if (native()) await invoke('host_leftover', { id, action }); },
  async setHub(url: string) { if (native()) await invoke('host_set_hub', { url }); },
  async reach(id: string, hub: string): Promise<Reach> {
    if (!native()) return { verdict: 'reachable', publicIp: '85.10.20.30', tcp: 'open', detail: null };
    return invoke<Reach>('host_reach', { id, hub });
  },
  async firewall(id: string): Promise<FirewallInfo> {
    if (!native()) return { supported: true, exists: false, command: 'netsh advfirewall firewall add rule name="TM Horizon server sa1" dir=in action=allow program=...\\TrackmaniaServer.exe protocol=TCP localport=2350,3450 ...' };
    return invoke<FirewallInfo>('host_firewall', { id });
  },
  async firewallAdd(id: string): Promise<boolean> { return native() ? invoke<boolean>('host_firewall_add', { id }) : true; },
  async listingSubmit(id: string, hub: string, contact: string): Promise<ServerDef> { return invoke<ServerDef>('host_listing_submit', { id, hub, contact, consent: true }); },
  async listingWithdraw(id: string): Promise<ServerDef> { return invoke<ServerDef>('host_listing_withdraw', { id }); },
  async localMaps(game: string): Promise<MapMeta[]> {
    if (!native()) return structuredClone(sampleMaps);
    return invoke<MapMeta[]>('host_local_maps', { game });
  },
  /** Map files from anywhere: only maps come back, the rest is listed as skipped. */
  async pickMaps(): Promise<Picked> { return native() ? invoke<Picked>('host_pick_maps') : { maps: [], skipped: [] }; },
  /** Thumbnail embedded in a map file (data: URL, stored upside down). */
  async mapThumb(path: string): Promise<string | null> { return native() ? invoke<string | null>('host_map_thumb', { path }) : null; },
  /** Header facts for the server's map list (TMX entries: the server's downloaded copy). */
  async mapsMeta(id: string, game: string, maps: MapRef[]): Promise<(MapMeta | null)[]> {
    if (!native()) return maps.map((m) => (m.kind === 'file' ? sampleMaps.find((x) => x.path === m.path) ?? null : null));
    return invoke<(MapMeta | null)[]>('host_maps_meta', { id, game, maps });
  },
  /** A pasted TMX map id, map link, pack id/link ("pack:123"), search link or words. */
  async tmxPreview(game: string, input: string): Promise<TmxPreview> {
    if (!native()) {
      const pack = /pack/i.test(input);
      const names = pack ? ['$f00Full$fffspeed 1', '$f00Full$fffspeed 2', 'Fullspeed 3 $i(night)', 'FS 4 - Loop', 'FS 5 - Finale'] : ['$f00Sample$fff Map'];
      return { kind: pack ? 'pack' : 'map', title: pack ? 'FSE 1' : null, owner: pack ? 'someone' : null, more: false, hits: names.map((n, i) => ({ id: 13775293 + i, name: n, author: 'someone', authorTime: 41000 + i * 3170, environment: 'Stadium', thumb: null })) };
    }
    return invoke<TmxPreview>('host_tmx_preview', { game, input });
  },
  async tmxAdd(id: string, game: string, ids: number[]): Promise<TmxAddResult> {
    if (!native()) return { added: ids.map((x) => ({ id: x, name: 'TMX ' + x })), failed: [] };
    return invoke<TmxAddResult>('host_tmx_add', { id, game, ids });
  },
  onTmxProgress(f: (p: { id: string; done: number; total: number }) => void): () => void {
    if (!native()) return () => undefined;
    let un: (() => void) | null = null;
    void listen<{ id: string; done: number; total: number }>('host-tmx-progress', (e) => f(e.payload)).then((u) => { un = u; });
    return () => un?.();
  },
  /** Cancelled wizard of a new server: its folder (TMX maps) goes. */
  async discard(id: string) { if (native()) await invoke('host_discard', { id }); },
  async dismissNotice(id: string) { if (native()) await invoke('host_dismiss_notice', { id }); else { const s = sample.servers.find((x) => x.def.id === id); if (s) s.dropped = []; changed(); } },
  /** Players seen on the server, newest first. */
  async seen(id: string): Promise<SeenPlayer[]> { return native() ? invoke<SeenPlayer[]>('host_seen', { id }) : structuredClone(sampleSeen); },
  async console(id: string): Promise<ConsoleState> { return native() ? invoke<ConsoleState>('host_console', { id }) : structuredClone(sampleConsole); },
  async consoleDo(id: string, cmd: ConsoleCmd): Promise<void> {
    if (native()) { await invoke('host_console_do', { id, cmd }); return; }
    if (cmd.action === 'chat' && cmd.text) sampleConsole.chat.push('$z' + cmd.text);
    if (cmd.action === 'next' || cmd.action === 'jump') { sampleConsole.current = cmd.action === 'jump' ? cmd.value ?? 0 : ((sampleConsole.current ?? 0) + 1) % sampleConsole.maps.length; }
    if (cmd.action === 'timelimit') sampleConsole.nextTimeLimitS = cmd.value ?? 300;
    if (cmd.action === 'spec' || cmd.action === 'play') sampleStatus.players.forEach((p) => { if (p.login === cmd.login) p.spectator = cmd.action === 'spec'; });
    if (cmd.action === 'kick' || cmd.action === 'ban') sampleStatus.players = sampleStatus.players.filter((p) => p.login !== cmd.login);
  },
  async runningCount(): Promise<number> { return native() ? invoke<number>('host_running_count') : 0; },
  async closeChoice(choice: 'keep' | 'stop') { if (native()) await invoke('host_close_choice', { choice }); },
  /** "host-state" events (native) or sample changes (preview). */
  subscribe(f: () => void): () => void {
    listeners.add(f);
    let un: (() => void) | null = null;
    if (native()) void listen('host-state', () => f()).then((u) => { un = u; });
    return () => { listeners.delete(f); un?.(); };
  },
  onCloseAsk(f: (n: number) => void): () => void {
    if (!native()) return () => undefined;
    let un: (() => void) | null = null;
    void listen<number>('host-close-ask', (e) => f(e.payload)).then((u) => { un = u; });
    return () => un?.();
  },
};

/** Error codes from Rust ("host.err.x" or "host.err.x:detail") -> [i18n key, detail]. */
export function errKey(e: unknown): [string, string] {
  const s = String(e);
  const m = /^(host\.err\.[A-Za-z]+|upnp\.[a-z]+|randomizer\.[A-Za-z]+)(?::(.*))?$/s.exec(s);
  return m ? [m[1], m[2] ?? ''] : ['host.err.other', s];
}

export const isValidPort = (p: number) => Number.isInteger(p) && p >= 1024 && p <= 65535;

/** m:ss.cc from milliseconds (author times). */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '';
  const cs = Math.floor(ms / 10) % 100;
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Valid map file name (the class check in Rust decides; this only keeps the UI honest). */
export const isMapFileName = (p: string) => /\.(challenge|map)\.gbx$/i.test(p);
