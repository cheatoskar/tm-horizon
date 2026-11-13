// Admin console and live log of a running dedicated server (shown in the server card).
// Backend: host.console / host.consoleDo / host.log in src/data/hosting.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, FastForward, Gamepad2, Pause, Play, RefreshCw, RotateCcw, Send, UserCheck, UserMinus, UserX, Ban } from 'lucide-react';
import '../../styles-hostconsole.css';
import { useHubState } from '../../state';
import { useT } from '../../i18n';
import { errKey, host, type ConsoleCmd, type ConsoleState } from '../../data/hosting';
import { TmRich } from './TmPreview';

function useErr() {
  const t = useT();
  return (e: unknown) => { const [k, d] = errKey(e); return t(k, { detail: d }); };
}

/** Keeps a scroll box at the bottom unless the user scrolled up. */
function useStick<T extends HTMLElement>(dep: unknown, on = true) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const onScroll = () => { const el = ref.current; if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  useEffect(() => { const el = ref.current; if (el && on && stuck.current) el.scrollTop = el.scrollHeight; }, [dep, on]);
  return { ref, onScroll };
}

export function ConsolePanel({ id, running }: { id: string; running: boolean }) {
  const t = useT();
  const hub = useHubState();
  const err = useErr();
  const [st, setSt] = useState<ConsoleState | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [limit, setLimit] = useState('');
  const limitTouched = useRef(false);
  const chatKey = st ? st.chat.length + ':' + (st.chat[st.chat.length - 1] ?? '') : '';
  const chatScroll = useStick<HTMLDivElement>(chatKey);

  const load = useCallback(() => {
    if (!running) return Promise.resolve();
    return host.console(id).then((s) => { setSt(s); setE(null); }, (x) => setE(err(x)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, id]);
  useEffect(() => {
    if (!running) return;
    void load();
    const i = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(i);
  }, [running, load]);
  useEffect(() => {
    if (st && !limitTouched.current) setLimit(String(st.nextTimeLimitS ?? st.timeLimitS ?? ''));
  }, [st]);

  if (!running) return <div className="dim small">{t('hostcon.notRunning')}</div>;
  if (!st) return e ? <div className="hs-error">{e}</div> : <div className="dim small">{t('hostcon.loading')}</div>;

  const run = (cmd: ConsoleCmd) => host.consoleDo(id, cmd).then(load, (x) => hub.toast({ message: err(x), ok: false }));
  const ask = (title: string, body: string, ok: string, cmd: ConsoleCmd) => hub.setConfirm({ title, text: body, ok, onOk: () => { void run(cmd); } });
  const { live } = st;
  const sendChat = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    void run({ action: 'chat', text: v });
  };
  const limitNum = Number(limit);
  const limitOk = limit.trim() !== '' && Number.isInteger(limitNum) && limitNum >= 0 && limitNum <= 7200;
  const shownLimit = st.nextTimeLimitS ?? st.timeLimitS;

  return (
    <div className="hc-root">
      <div className="hc-head">
        <span className="grow hc-headline">
          {live.map ? <TmRich text={live.map} /> : <span className="dim">{t('hostcon.noMap')}</span>}
          {live.mode && <span className="dim small"> · {live.mode}</span>}
          <span className="dim small"> · {t('hostcon.playerCount', { n: live.players.length - live.spectators, max: live.maxPlayers })}</span>
        </span>
        <button className="btn ghost sm" onClick={() => { void load(); }} aria-label={t('hostcon.refresh')} title={t('hostcon.refresh')}><RefreshCw size={14} /></button>
      </div>
      {e && <div className="hs-error">{e}</div>}

      <div className="hc-cols">
        <div className="hc-col">
          <section className="hc-sec">
            <h4 className="hc-title">{t('hostcon.players')}</h4>
            {live.players.length === 0 && <div className="dim small">{t('hostcon.noPlayers')}</div>}
            {live.players.map((p) => {
              const guest = live.guests.includes(p.login);
              return (
                <div className="hc-player" key={p.login}>
                  <span className="hc-who">
                    <TmRich text={p.nick || p.login} /> <span className="dim small mono">{p.login}</span>
                    {p.spectator && <span className="pill tiny">{t('hostcon.spectator')}</span>}
                  </span>
                  <span className="hc-btns">
                    <button className="btn ghost sm" title={t('hostcon.kickTip')} onClick={() => { void run({ action: 'kick', login: p.login }); }}><UserMinus size={13} />{t('hostcon.kick')}</button>
                    <button className="btn ghost sm danger" title={t('hostcon.banTip')} onClick={() => ask(t('hostcon.banTitle'), t('hostcon.banText', { login: p.login }), t('hostcon.ban'), { action: 'ban', login: p.login })}><Ban size={13} />{t('hostcon.ban')}</button>
                    <button className="btn ghost sm" title={guest ? t('hostcon.unguestTip') : t('hostcon.guestTip')} onClick={() => { void run({ action: guest ? 'unguest' : 'guest', login: p.login }); }}>{guest ? <UserX size={13} /> : <UserCheck size={13} />}{guest ? t('hostcon.unguest') : t('hostcon.guest')}</button>
                    <button className="btn ghost sm" title={p.spectator ? t('hostcon.playTip') : t('hostcon.specTip')} onClick={() => { void run({ action: p.spectator ? 'play' : 'spec', login: p.login }); }}>{p.spectator ? <Gamepad2 size={13} /> : <Eye size={13} />}{p.spectator ? t('hostcon.play') : t('hostcon.spec')}</button>
                  </span>
                </div>
              );
            })}
          </section>

          <section className="hc-sec">
            <h4 className="hc-title">{t('hostcon.chat')}</h4>
            <div className="hc-chat" ref={chatScroll.ref} onScroll={chatScroll.onScroll} role="log" aria-label={t('hostcon.chat')}>
              {st.chat.length === 0 && <div className="dim small">{t('hostcon.noChat')}</div>}
              {st.chat.map((l, i) => <div className="hc-chatline" key={i}><TmRich text={l} /></div>)}
            </div>
            <div className="hc-send">
              <input className="text-in grow" value={text} maxLength={200} aria-label={t('hostcon.chatInput')} placeholder={t('hostcon.chatPlaceholder')}
                onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); sendChat(); } }} />
              <button className="btn primary sm" disabled={!text.trim()} onClick={sendChat}><Send size={13} />{t('hostcon.send')}</button>
            </div>
            <div className="dim small">{t('hostcon.chatHint')}</div>
          </section>
        </div>

        <div className="hc-col">
          <section className="hc-sec">
            <h4 className="hc-title">{t('hostcon.maps')}</h4>
            <div className="hc-btns">
              <button className="btn ghost sm" onClick={() => { void run({ action: 'next' }); }}><FastForward size={13} />{t('hostcon.next')}</button>
              <button className="btn ghost sm" onClick={() => ask(t('hostcon.restartTitle'), t('hostcon.restartText'), t('hostcon.restart'), { action: 'restart' })}><RotateCcw size={13} />{t('hostcon.restart')}</button>
            </div>
            <div className="hc-maps">
              {st.maps.length === 0 && <div className="dim small">{t('hostcon.noMaps')}</div>}
              {st.maps.map((m, i) => (
                <div className={'hc-map' + (i === st.current ? ' is-cur' : '')} key={i + m.file}>
                  <span className="dim small mono hc-idx">{i + 1}</span>
                  <span className="hc-who">
                    <TmRich text={m.name} /> <span className="dim small">{m.author}</span>
                    {i === st.current && <span className="pill tiny">{t('hostcon.current')}</span>}
                    {i === st.next && i !== st.current && <span className="pill tiny">{t('hostcon.upNext')}</span>}
                  </span>
                  <button className="btn ghost sm" disabled={i === st.current} title={t('hostcon.jumpTip')} onClick={() => { void run({ action: 'jump', value: i }); }}><Play size={13} />{t('hostcon.jump')}</button>
                </div>
              ))}
            </div>
          </section>

          <section className="hc-sec">
            <h4 className="hc-title">{t('hostcon.match')}</h4>
            <div className="hc-limit dim small">
              {t('hostcon.limitNow', { s: st.timeLimitS ?? '?' })}
              {st.nextTimeLimitS != null && st.nextTimeLimitS !== st.timeLimitS && <> · {t('hostcon.limitNext', { s: st.nextTimeLimitS })}</>}
            </div>
            <div className="hc-send">
              <input className="text-in hc-num" type="number" min={0} max={7200} step={1} value={limit} aria-label={t('hostcon.limitInput')}
                onChange={(ev) => { limitTouched.current = true; setLimit(ev.target.value); }}
                onKeyDown={(ev) => { if (ev.key === 'Enter' && limitOk) { limitTouched.current = false; void run({ action: 'timelimit', value: limitNum }); } }} />
              <button className="btn primary sm" disabled={!limitOk || limitNum === shownLimit} onClick={() => { limitTouched.current = false; void run({ action: 'timelimit', value: limitNum }); }}>{t('hostcon.set')}</button>
            </div>
            <div className="dim small">{t('hostcon.limitHint')}</div>
            {st.canPause ? (
              <div className="hc-btns">
                <button className="btn ghost sm" onClick={() => { void run({ action: 'pause' }); }}><Pause size={13} />{t('hostcon.pause')}</button>
                <button className="btn ghost sm" onClick={() => { void run({ action: 'resume' }); }}><Play size={13} />{t('hostcon.resume')}</button>
              </div>
            ) : <div className="dim small">{t('hostcon.noPause')}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

export function LogPanel({ id, running }: { id: string; running: boolean }) {
  const t = useT();
  const hub = useHubState();
  const [text, setText] = useState('');
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const load = useCallback(() => { host.log(id).then(setText, () => setText('')); }, [id]);
  useEffect(() => {
    load();
    if (!running || !follow) return;
    const i = setInterval(load, 2000);
    return () => clearInterval(i);
  }, [load, running, follow]);

  const lines = useMemo(() => {
    const all = text.split(/\r?\n/);
    while (all.length && all[all.length - 1] === '') all.pop();
    const f = filter.trim().toLowerCase();
    return f ? all.filter((l) => l.toLowerCase().includes(f)) : all;
  }, [text, filter]);
  const scroll = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = scroll.current; if (el && follow) el.scrollTop = el.scrollHeight; }, [lines, follow]);

  const copy = () => {
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => hub.toast({ message: t('hostcon.copied'), ok: true }),
      () => hub.toast({ message: t('hostcon.copyFailed'), ok: false }),
    );
  };
  const cls = (l: string) => {
    const s = l.toLowerCase();
    return /error|failed|refused/.test(s) ? 'hc-l-bad' : s.includes('warning') ? 'hc-l-warn' : undefined;
  };

  return (
    <div className="hc-log">
      <div className="hc-logbar">
        <input className="text-in grow" value={filter} aria-label={t('hostcon.filter')} placeholder={t('hostcon.filter')} onChange={(ev) => setFilter(ev.target.value)} />
        <label className="hc-follow"><input type="checkbox" checked={follow} onChange={(ev) => setFollow(ev.target.checked)} />{t('hostcon.follow')}</label>
        <button className="btn ghost sm" onClick={copy} disabled={lines.length === 0}><Copy size={13} />{t('hostcon.copy')}</button>
        <button className="btn ghost sm" onClick={load} aria-label={t('hostcon.refresh')} title={t('hostcon.refresh')}><RefreshCw size={14} /></button>
      </div>
      <pre className="hc-pre" ref={scroll} tabIndex={0}>
        {lines.length === 0
          ? <span className="dim">{t('hostcon.logEmpty')}</span>
          : lines.map((l, i) => <span key={i} className={cls(l)}>{l + '\n'}</span>)}
      </pre>
    </div>
  );
}
