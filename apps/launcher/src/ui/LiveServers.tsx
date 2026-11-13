// Live server status from the game's own server query (data/serverQuery.ts): the list on the Servers
// page and on the ESWC, Sunrise and Original game pages, the "known servers" dialog and the
// settings block.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Copy, Lock, RefreshCw, Server, Trash2, ListPlus } from 'lucide-react';
import { isNative } from '../data/backend';
import {
  LAUNCHER_ID, QGAMES, addServer, exportServers, fmtMs, importServers, joinLink, loadRegistry, onQueryChange, queryState, refreshStatus, removeServer, resetSeeds,
  rowKey, setQueryEnabled, type QGame, type QRow, type RegEntry,
} from '../data/serverQuery';
import { copyText } from '../pages/CommunityServices';
import { useHubState } from '../state';
import { ago, useT } from '../i18n';
import { GameChip, SectionHead, TmText, Toggle } from './common';
import { Modal } from './Modal';
import { JoinGuideButton, needsJoinGuide } from './JoinGuide';

export type LiveSort = 'players' | 'name' | 'game' | 'ping';
const GAME_NAME: Record<QGame, string> = { tmnf: 'Nations Forever', tmuf: 'United Forever', eswc: 'Nations ESWC', tms: 'Sunrise', tmo: 'Original' };

function useQuery() {
  return useSyncExternalStore(onQueryChange, queryState);
}

/** Seconds below a minute, the shared relative time above. */
function useSince() {
  const t = useT();
  return (ms: number) => {
    if (!ms) return '-';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? t('live.secAgo', { n: s }) : ago(new Date(ms).toISOString());
  };
}

interface Line { entry: RegEntry; row: QRow | null }

function limitText(r: QRow, t: ReturnType<typeof useT>): string {
  const i = r.info;
  if (!i || !i.limit) return '';
  if (i.limitKind === 'ms') return fmtMs(i.limit);
  if (i.limitKind === 'laps') return t('live.laps', { n: i.limit });
  if (i.limitKind === 'points') return t('live.points', { n: i.limit });
  return '';
}

function LiveRow({ line, compact }: { line: Line; compact: boolean }) {
  const hub = useHubState();
  const t = useT();
  const since = useSince();
  const { entry, row } = line;
  const info = row?.info ?? null;
  const online = row?.state === 'ok';
  const g = hub.game(LAUNCHER_ID[entry.game]);
  const installed = !!g?.installed;
  const link = row ? joinLink(row) : null;
  const full = online && !!info && info.players >= info.maxPlayers;
  const lim = row ? limitText(row, t) : '';
  const map = info?.maps[0];
  const tip = !installed ? t('play.gameMissing') : full ? t('servers.full') : link ? t('servers.opens', { join: link }) : '';
  return (
    <div className={'tr live-tr' + (compact ? ' compact' : '') + (online ? '' : ' off')}>
      <span className="srv">
        {info ? <TmText text={info.nameRaw} className="ellip" title={info.name} /> : <span className="ellip" title={entry.name ?? entry.address}>{entry.name ?? entry.address}</span>}
        <span className="dim small ellip">
          <code className="mono small">{entry.address}</code>
          {/* A preset server that answers is current; the hint only matters when it does not. */}
          {entry.source === 'seed' && !online && <span className="pill tiny muted" title={t('live.seedTip')}>{t('live.seed')}</span>}
          {entry.source === 'community' && <span className="pill tiny muted" title={t('live.communityTip')}>{t('live.community')}</span>}
          {entry.source === 'community' && entry.suggested && <span className="pill tiny muted" title={t('live.suggestedTip')}>{t('live.suggested')}</span>}
          {info && info.ladderMode > 0 && <span className="pill tiny muted" title={t('live.ladderTip')}>{t('live.ladder')}</span>}
          {info?.password && <Lock size={12} className="live-lock" aria-label={t('live.password')} />}
          {info?.spectatorPassword && !info.password && <span className="pill tiny muted" title={t('live.specPassword')}>{t('live.specPasswordShort')}</span>}
        </span>
      </span>
      {!compact && <span><GameChip id={LAUNCHER_ID[entry.game]} /></span>}
      <span className="dim ellip" title={info?.mode ?? ''}>{info?.mode ? info.mode + (lim ? ' · ' + lim : '') : '-'}</span>
      <span className="ellip" title={map?.name ?? ''}>{map ? <TmText text={map.nameRaw} /> : <span className="dim">-</span>}</span>
      <span className="players">
        {online && info ? (
          <>
            <span className="bar"><i style={{ width: `${Math.min(100, (info.players / Math.max(1, info.maxPlayers)) * 100)}%` }} /></span>
            <span className="small nowrap" title={t('live.spectators', { n: info.spectators, max: info.maxSpectators })}>{info.players}/{info.maxPlayers}{info.spectators > 0 ? ` +${info.spectators}` : ''}</span>
          </>
        ) : <span className="dim small">-</span>}
      </span>
      <span className="small nowrap live-state" title={row ? (online ? t('live.checked', { when: since(row.checkedAt) }) : (row.errorText ?? '')) : ''}>
        {!row ? <span className="dim">{t('live.waiting')}</span>
          : online ? <><span className="dot on" /> {row.pingMs ?? '?'} ms</>
          : <span className="dim"><span className="dot" /> {t('live.offline')}</span>}
        {row && <span className="dim live-ago"> {since(row.checkedAt)}</span>}
      </span>
      <span>
        {online && link && (
          <button className="btn primary sm" disabled={!installed || full} title={tip} onClick={() => g && hub.play(g.id, link)}>{t('event.join')}</button>
        )}
        {online && !link && needsJoinGuide(g?.id) && (
          <JoinGuideButton game={g!.id} name={info?.name || entry.name || entry.address} address={entry.address} primary />
        )}
        {online && !link && !needsJoinGuide(g?.id) && (
          <button className="btn ghost sm" title={t('server.addressTip')} onClick={() => copyText(entry.address, () => hub.toast({ message: t('server.copied', { address: entry.address }) }))}><Copy size={13} /> {t('common.copy')}</button>
        )}
      </span>
    </div>
  );
}

/** The live list. `games` picks the games, `q` and `sort` come from the page's own toolbar when it has one. */
export function LiveServers({ games, q = '', sort = 'players', compact = false, title }: { games: QGame[]; q?: string; sort?: LiveSort; compact?: boolean; title?: string }) {
  const t = useT();
  const st = useQuery();
  const since = useSince();
  const [dialog, setDialog] = useState(false);
  const [hideOffline, setHideOffline] = useState(false);
  const key = games.join(',');

  useEffect(() => {
    if (!isNative) return;
    void loadRegistry();
    const run = () => { if (document.visibilityState === 'visible') void refreshStatus(games); };
    run();
    const id = window.setInterval(run, 60_000);
    document.addEventListener('visibilitychange', run);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lines: Line[] = useMemo(() => {
    const reg = st.registry?.servers ?? [];
    const needle = q.trim().toLowerCase();
    const all = reg.filter((e) => games.includes(e.game)).map((entry) => ({ entry, row: st.rows[rowKey(entry.game, entry.address)] ?? null }));
    const shown = all.filter((l) => {
      if (hideOffline && l.row?.state !== 'ok') return false;
      if (!needle) return true;
      const i = l.row?.info;
      return [l.entry.address, l.entry.name ?? '', i?.name ?? '', i?.mode ?? '', i?.maps[0]?.name ?? '', i?.hostLogin ?? ''].join(' ').toLowerCase().includes(needle);
    });
    const on = (l: Line) => (l.row?.state === 'ok' ? 1 : 0);
    const name = (l: Line) => l.row?.info?.name ?? l.entry.name ?? l.entry.address;
    return shown.sort((a, b) => {
      const byOn = on(b) - on(a);
      const byPlayers = (b.row?.info?.players ?? -1) - (a.row?.info?.players ?? -1);
      const byName = name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
      if (sort === 'name') return byOn || byName;
      if (sort === 'game') return QGAMES.indexOf(a.entry.game) - QGAMES.indexOf(b.entry.game) || byOn || byPlayers;
      if (sort === 'ping') return byOn || (a.row?.pingMs ?? 1e9) - (b.row?.pingMs ?? 1e9) || byName;
      return byOn || byPlayers || byName;
    });
  }, [st.registry, st.rows, games, q, sort, hideOffline]);

  if (!isNative) return null;
  const off = st.registry && !st.registry.enabled;
  const onlineN = lines.filter((l) => l.row?.state === 'ok').length;
  const players = lines.reduce((n, l) => n + (l.row?.state === 'ok' ? l.row.info?.players ?? 0 : 0), 0);
  return (
    <div className="live-servers">
      <SectionHead title={title ?? t('live.title')}
        sub={off ? t('live.off') : t('live.sub', { online: onlineN, total: lines.length, players, when: since(st.lastRun) })}
        right={<>
          <label className="live-check small dim"><input type="checkbox" checked={hideOffline} onChange={(e) => setHideOffline(e.target.checked)} /> {t('live.hideOffline')}</label>
          <button className="btn ghost sm" title={t('live.refreshTip')} disabled={st.loading || !!off} onClick={() => void refreshStatus(games, true)}><RefreshCw size={14} className={st.loading ? 'spin' : ''} /></button>
          <button className="btn ghost sm" title={t('live.manageTip')} onClick={() => setDialog(true)}><ListPlus size={14} /> {t('live.manage')}</button>
        </>} />
      {off ? (
        <div className="notice slim"><Server size={16} /><div className="small">{t('live.offNote')} <button className="linkish small" onClick={() => void setQueryEnabled(true)}>{t('live.turnOn')}</button></div></div>
      ) : (
        <div className="table live-table">
          <div className={'tr th live-tr' + (compact ? ' compact' : '')}>
            <span>{t('servers.colServer')}</span>{!compact && <span>{t('servers.colGame')}</span>}<span>{t('servers.colMode')}</span><span>{t('live.colMap')}</span><span>{t('servers.colPlayers')}</span><span>{t('live.colPing')}</span><span />
          </div>
          {lines.map((l) => <LiveRow key={rowKey(l.entry.game, l.entry.address)} line={l} compact={compact} />)}
          {lines.length === 0 && (st.registry
            ? <div className="live-empty empty-rich">
                <Server size={22} />
                <b>{q.trim() || hideOffline ? t('live.noMatch') : t('live.noneFor', { games: games.map((g) => GAME_NAME[g]).join(', ') })}</b>
                {!q.trim() && !hideOffline && <button className="btn primary sm" onClick={() => setDialog(true)}><ListPlus size={14} /> {t('live.addServer')}</button>}
              </div>
            : <div className="live-empty dim small">{t('live.loading')}</div>)}
        </div>
      )}
      {!off && <p className="dim small live-foot">{t('live.foot')} <span className="more-tip" tabIndex={0} title={t('live.footMore')}>{t('common.more')}</span></p>}
      {dialog && <ServerListDialog games={games} onClose={() => setDialog(false)} />}
    </div>
  );
}

/** Add, remove, export and import the known servers. */
export function ServerListDialog({ games, onClose }: { games?: QGame[]; onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const st = useQuery();
  const allowed = games?.length ? games : QGAMES;
  const [game, setGame] = useState<QGame>(allowed[0]);
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void loadRegistry(); }, []);
  const servers = st.registry?.servers ?? [];

  const add = async () => {
    setError(null);
    const r = await addServer(game, input, name);
    if (r.ok) { setInput(''); setName(''); void refreshStatus([game], true); hub.toast({ message: t('live.added') }); }
    else setError(t('live.err.' + (['needs-address', 'bad-address', 'bad-game', 'exists', 'full'].includes(r.code) ? r.code : 'other')));
  };
  const doExport = async () => {
    const json = await exportServers().catch(() => '');
    setText(json);
    if (json) copyText(json, () => setMsg(t('live.exported')));
  };
  const doImport = async () => {
    setMsg(null);
    const r = await importServers(text);
    if ('error' in r) { setMsg(t('live.err.import')); return; }
    setMsg(t('live.imported', { added: r.added, skipped: r.skipped }));
    if (r.added) void refreshStatus(QGAMES, true);
  };
  return (
    <Modal title={t('live.manageTitle')} onClose={onClose} wide actions={<button className="btn ghost" onClick={onClose}>{t('common.close')}</button>}>
      <div className="live-dlg">
        <b>{t('live.addTitle')}</b>
        <div className="dim small">{t('live.addNote')}</div>
        <div className="live-add">
          <select className="text-in" value={game} onChange={(e) => setGame(e.target.value as QGame)} aria-label={t('servers.colGame')}>
            {allowed.map((g) => <option key={g} value={g}>{GAME_NAME[g]}</option>)}
          </select>
          <input className="text-in mono grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('live.addPlaceholder')} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} aria-label={t('live.addTitle')} />
          <input className="text-in" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('live.namePlaceholder')} maxLength={80} aria-label={t('live.namePlaceholder')} />
          <button className="btn primary sm" disabled={!input.trim()} onClick={() => void add()}>{t('live.add')}</button>
        </div>
        {error && <div className="live-error small">{error}</div>}

        <b>{t('live.listTitle', { n: servers.filter((s) => allowed.includes(s.game)).length })}</b>
        <div className="live-list">
          {servers.filter((s) => allowed.includes(s.game)).map((s) => (
            <div className="live-item" key={rowKey(s.game, s.address)}>
              <GameChip id={LAUNCHER_ID[s.game]} />
              <code className="mono small grow ellip" title={s.address}>{s.address}</code>
              <span className="dim small ellip">{s.source === 'seed' ? t('live.seed') : s.source === 'community' ? t('live.community') + (s.suggested ? ' / ' + t('live.suggested') : '') : s.name ?? ''}</span>
              {s.source === 'community'
                ? <span className="icon-gap" />
                : <button className="btn icon tiny" title={t('common.remove')} aria-label={t('common.remove')} onClick={() => void removeServer(s.game, s.address)}><Trash2 size={13} /></button>}
            </div>
          ))}
          {servers.length === 0 && <div className="dim small">{t('live.none')}</div>}
        </div>

        <b>{t('live.shareTitle')}</b>
        <div className="dim small">{t('live.shareNote')}</div>
        <textarea className="text-in mono live-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={5} aria-label={t('live.shareTitle')} />
        <div className="live-add">
          <button className="btn ghost sm" onClick={() => void doExport()}>{t('live.export')}</button>
          <button className="btn ghost sm" disabled={!text.trim()} onClick={() => void doImport()}>{t('live.import')}</button>
          <button className="btn ghost sm" title={t('live.resetSeedsTip')} onClick={() => void resetSeeds().then(() => refreshStatus(QGAMES, true))}>{t('live.resetSeeds')}</button>
          {msg && <span className="dim small">{msg}</span>}
        </div>
      </div>
    </Modal>
  );
}

/** Settings > Servers. */
export function ServersSettings() {
  const t = useT();
  const st = useQuery();
  const [dialog, setDialog] = useState(false);
  useEffect(() => { void loadRegistry(); }, []);
  if (!isNative) return null;
  const reg = st.registry;
  return (
    <div className="settings-block">
      <h2>{t('live.settingsTitle')}</h2>
      <section className="panel">
        <div className="setrow">
          <Server size={18} />
          <div className="grow"><b>{t('live.settingsToggle')}</b><div className="dim small setnote">{t('live.settingsNote')} <span className="more-tip" tabIndex={0} title={t('live.privacyMore')}>{t('common.more')}</span></div></div>
          <Toggle on={!!reg?.enabled} label={t('live.settingsToggle')} onChange={() => void setQueryEnabled(!reg?.enabled)} />
        </div>
        <div className="setrow">
          <div className="grow"><b>{t('live.settingsKnown', { n: reg?.servers.length ?? 0 })}</b><div className="dim small setnote">{t('live.settingsKnownNote')}</div></div>
          <button className="btn ghost sm" onClick={() => setDialog(true)}>{t('live.manage')}</button>
        </div>
      </section>
      {dialog && <ServerListDialog onClose={() => setDialog(false)} />}
    </div>
  );
}
