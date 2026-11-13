// "Eigener Server": list of the player's own servers, the create/edit wizard, and per server the
// players, lists, internet steps and log. Backend: src/data/hosting.ts -> src-tauri/src/hosting.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Globe, Loader2, Pencil, Play, Plus, Server, Square, Trash2, Wifi, X, XCircle } from 'lucide-react';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from '../ui/Modal';
import { GameChip, Toggle } from '../ui/common';
import { TmFormatBar, TmPreview, TmRich } from '../ui/hosting/TmPreview';
import { LoginList } from '../ui/hosting/LoginList';
import { MapPicker } from '../ui/hosting/MapPicker';
import { ConsolePanel, LogPanel } from '../ui/hosting/Console';
import { isValidLogin } from '../data/logins';
import { getHubSource } from '../data/hubIndex';
import { backend } from '../data/backend';
import {
  AUTO_SKIP, MODES_LEGACY, MODES_SCRIPT, RANDOMIZER_PRESETS, errKey, host, isValidPort,
  type Kind, type Overview, type Reach, type SeenPlayer, type ServerDef, type ServerRow,
} from '../data/hosting';

/** Launcher game ids for the GameChip. */
const CHIP: Record<string, string> = { tmnf: 'tmnf', tmuf: 'tmuf', eswc: 'tmn-eswc', tms: 'tm-sunrise', tmo: 'tm-original', tm2: 'tm2-stadium', tm2020: 'tm2020' };

function useErr() {
  const t = useT();
  return (e: unknown) => { const [k, d] = errKey(e); return t(k, { detail: d }); };
}

export function HostServers() {
  const t = useT();
  const hub = useHubState();
  const err = useErr();
  const [ov, setOv] = useState<Overview | null>(null);
  const [edit, setEdit] = useState<ServerDef | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => { host.overview().then(setOv).catch((e) => hub.toast({ message: err(e), ok: false })); }, []);
  useEffect(() => { reload(); return host.subscribe(reload); }, [reload]);
  useEffect(() => { const s = getHubSource(); if (s.enabled && s.url) void host.setHub(s.url); }, []);
  if (!ov) return <div className="dim small">{t('host.loading')}</div>;
  const kind = (g: string) => ov.kinds.find((k) => k.id === g);
  const act = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    try { await f(); } catch (e) { hub.toast({ message: err(e), ok: false }); } finally { setBusy(null); reload(); }
  };
  const newServer = async () => { try { setEdit(await host.create('tmnf')); } catch (e) { hub.toast({ message: err(e), ok: false }); } };
  return (
    <div className="hs-page">
      <div className="hs-head">
        <div>
          <h2>{t('host.title')}</h2>
          <span className="dim small">{t('host.sub')}</span>
        </div>
        <button className="btn primary" onClick={newServer}><Plus size={16} />{t('host.new')}</button>
      </div>

      {ov.servers.filter((s) => s.leftover).map((s) => (
        <div className="notice slim" key={'lo' + s.def.id}>
          <AlertTriangle size={16} />
          <div className="small">{t('host.leftover', { name: '' })}<TmRich text={s.def.name} /></div>
          <button className="btn ghost sm" onClick={() => act(s.def.id, () => host.leftover(s.def.id, 'stop'))}>{t('host.stop')}</button>
          <button className="btn ghost sm" onClick={() => act(s.def.id, () => host.leftover(s.def.id, 'forget'))}>{t('host.forget')}</button>
        </div>
      ))}

      {ov.servers.filter((s) => s.dropped?.length).map((s) => (
        <div className="notice slim" key={'dr' + s.def.id} role="status">
          <AlertTriangle size={16} />
          <div className="small grow">
            <TmRich text={s.def.name} />: {t('hostmaps.droppedNotice', { n: s.dropped!.length })}
            <div className="dim hs-dropped">{s.dropped!.slice(0, 4).join(' · ')}{s.dropped!.length > 4 ? ' · …' : ''}</div>
          </div>
          <button className="bbtn" aria-label={t('common.close')} onClick={() => { void host.dismissNotice(s.def.id).then(reload); }}><X size={14} /></button>
        </div>
      ))}

      {ov.servers.length === 0 && (
        <div className="panel hs-empty">
          <Server size={28} />
          <div>
            <b>{t('host.emptyTitle')}</b>
            <div className="dim small">{t('host.emptyText')}</div>
          </div>
          <button className="btn primary" onClick={newServer}><Plus size={16} />{t('host.new')}</button>
        </div>
      )}

      <div className="hs-servers">
        {ov.servers.map((s) => (
          <ServerCard key={s.def.id} row={s} kind={kind(s.def.game)} busy={busy === s.def.id} open={open === s.def.id}
            onOpen={() => setOpen(open === s.def.id ? null : s.def.id)}
            onStart={() => act(s.def.id, () => host.start(s.def.id))}
            onStop={() => act(s.def.id, () => host.stop(s.def.id))}
            onEdit={() => setEdit(structuredClone(s.def))}
            onDelete={() => hub.setConfirm({ title: t('host.deleteTitle'), text: t('host.deleteText'), ok: t('host.delete'), onOk: () => act(s.def.id, () => host.remove(s.def.id)) })}
            reload={reload} />
        ))}
      </div>

      {edit && <Wizard initial={edit} kinds={ov.kinds} isNew={!ov.servers.some((s) => s.def.id === edit.id)} hadAccount={!!ov.servers.find((s) => s.def.id === edit.id)?.hasAccount}
        onClose={() => { if (!ov.servers.some((s) => s.def.id === edit.id)) void host.discard(edit.id); setEdit(null); }} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function stateLabel(t: (k: string) => string, s: ServerRow) {
  const r = s.run;
  if (r.state === 'starting') return t('host.state.starting') + (r.step ? ' · ' + t('host.step.' + r.step) : '');
  return t('host.state.' + r.state);
}

function uptime(started: number | null) {
  if (!started) return '';
  const m = Math.max(0, Math.floor((Date.now() / 1000 - started) / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function ServerCard({ row, kind, busy, open, onOpen, onStart, onStop, onEdit, onDelete, reload }: {
  row: ServerRow; kind: Kind | undefined; busy: boolean; open: boolean;
  onOpen: () => void; onStart: () => void; onStop: () => void; onEdit: () => void; onDelete: () => void; reload: () => void;
}) {
  const t = useT();
  const err = useErr();
  const d = row.def;
  const r = row.run;
  const live = r.state === 'running' || r.state === 'starting' || r.state === 'stopping';
  return (
    <div className={'panel hs-card' + (open ? ' open' : '')}>
      <div className="hs-card-row">
        <span className={'hs-dot ' + r.state} />
        <div className="hs-card-main" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
          <div className="hs-card-name"><TmRich text={d.name} /></div>
          <div className="dim small hs-card-meta">
            <GameChip id={CHIP[d.game] ?? d.game} />
            <span className="pill tiny">{t('host.engine.' + d.engine)}</span>
            <span>{d.internet ? t('host.internet') : t('host.lan')}</span>
            <span className="mono">:{d.ports.game}</span>
            <span>{stateLabel(t, row)}{r.state === 'running' && r.started ? ' · ' + uptime(r.started) : ''}</span>
            {kind?.status === 'experimental' && <span className="pill tiny warn">{t('host.experimental')}</span>}
          </div>
          {r.error && <div className="hs-error">{err(r.error)}</div>}
          {!r.error && r.portsMovedFrom ? <div className="dim small">{t('host.portsMoved', { game: d.ports.game, p2p: d.ports.p2p, old: r.portsMovedFrom })}</div> : null}
        </div>
        <div className="row-btns">
          {!live && <button className="btn primary sm" disabled={busy} onClick={onStart}>{busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{t('host.start')}</button>}
          {live && <button className="btn ghost sm" disabled={busy || r.state === 'stopping'} onClick={onStop}><Square size={14} />{t('host.stop')}</button>}
          <button className="btn ghost sm" onClick={onEdit} disabled={live} title={live ? t('host.editRunning') : undefined}><Pencil size={14} />{t('host.edit')}</button>
          {!live && <button className="btn ghost sm danger" onClick={onDelete} aria-label={t('host.delete')}><Trash2 size={14} /></button>}
        </div>
      </div>
      {open && <ServerDetail row={row} kind={kind} reload={reload} />}
    </div>
  );
}

function ServerDetail({ row, kind, reload }: { row: ServerRow; kind: Kind | undefined; reload: () => void }) {
  const t = useT();
  const running = row.run.state === 'running';
  const [tab, setTab] = useState<'console' | 'lists' | 'internet' | 'log'>(running ? 'console' : row.def.internet ? 'internet' : 'lists');
  return (
    <div className="hs-detail">
      <div className="seg small-seg" role="tablist">
        {(['console', 'lists', 'internet', 'log'] as const).map((x) => <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>{t(x === 'console' ? 'hostmaps.tabConsole' : 'host.tab.' + x)}</button>)}
      </div>
      {tab === 'console' && <ConsolePanel id={row.def.id} running={running} />}
      {tab === 'lists' && <Lists row={row} reload={reload} />}
      {tab === 'internet' && <InternetSteps row={row} kind={kind} reload={reload} />}
      {tab === 'log' && <LogPanel id={row.def.id} running={running} />}
    </div>
  );
}

function Lists({ row, reload }: { row: ServerRow; reload: () => void }) {
  const t = useT();
  const hub = useHubState();
  const err = useErr();
  const [d, setD] = useState(row.def);
  const seen = useSeen(row.def.id);
  const dirty = JSON.stringify([d.guests, d.blacklist, d.admins]) !== JSON.stringify([row.def.guests, row.def.blacklist, row.def.admins]);
  const save = () => host.save(d).then(() => { hub.toast({ message: t('host.saved'), ok: true }); reload(); }, (e) => hub.toast({ message: err(e), ok: false }));
  return (
    <div className="hs-lists">
      <LoginList title={t('host.guests')} hint={t('host.guestsHint')} items={d.guests} onChange={(guests) => setD({ ...d, guests })} seen={seen} />
      <LoginList title={t('host.blacklist')} hint={t('host.blacklistHint')} items={d.blacklist} onChange={(blacklist) => setD({ ...d, blacklist })} seen={seen} />
      <LoginList title={t('host.admins')} hint={d.engine === 'randomizer' ? t('host.adminsHintRandomizer') : t('host.adminsHint')} items={d.admins} onChange={(admins) => setD({ ...d, admins })} seen={seen} />
      <div className="row-btns"><button className="btn primary sm" disabled={!dirty} onClick={save}>{t('host.save')}</button></div>
    </div>
  );
}

/** "TCP:2350, UDP:2350, TCP:3450, UDP:3450" -> "2350/3450". */
const upnpPorts = (mapped: string[]) => [...new Set(mapped.map((m) => m.split(':')[1]).filter(Boolean))].join('/');

/** Step-by-step for the internet: account, router, firewall, test, hub list. Each with a check. */
function InternetSteps({ row, kind, reload }: { row: ServerRow; kind: Kind | undefined; reload: () => void }) {
  const t = useT();
  const hub = useHubState();
  const err = useErr();
  const d = row.def;
  const [fw, setFw] = useState<{ exists: boolean; command: string; supported: boolean } | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [testing, setTesting] = useState(false);
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState('');
  const hubSrc = getHubSource();
  const hubUrl = hubSrc.enabled ? hubSrc.url : '';
  useEffect(() => { if (d.internet) host.firewall(d.id).then(setFw, () => setFw(null)); }, [d.id, d.internet]);
  if (!d.internet) return <div className="dim small">{t('host.lanOnly')}</div>;
  const running = row.run.state === 'running';
  const up = row.run.upnp;
  const test = async () => {
    if (!hubUrl) { hub.toast({ message: t('host.needHub'), ok: false }); return; }
    setTesting(true);
    try { setReach(await host.reach(d.id, hubUrl)); } catch (e) { hub.toast({ message: err(e), ok: false }); } finally { setTesting(false); }
  };
  const Mark = ({ ok }: { ok: boolean | null }) => ok === null ? <span className="hs-mark dim">–</span> : ok ? <CheckCircle2 size={16} className="hs-ok" /> : <XCircle size={16} className="hs-bad" />;
  return (
    <ol className="hs-steps">
      <li>
        <Mark ok={!!d.serverLogin && row.hasAccount} />
        <div>
          <b>{t('host.stepAccount')}</b>
          <div className="dim small">{kind?.loginPage ? t('host.accountHelpNew') : t('host.accountHelpTmf')}</div>
          {kind?.loginPage && <button className="btn ghost sm" onClick={() => backend.openExternal?.(kind.loginPage!)}><ExternalLink size={14} />{t('host.openAccountPage')}</button>}
          <div className="dim small">{d.serverLogin ? t('host.accountSaved', { login: d.serverLogin }) : t('host.accountMissing')}</div>
        </div>
      </li>
      <li>
        <Mark ok={up ? up.ok : d.upnp ? null : null} />
        <div>
          <b>{t('host.stepRouter')}</b>
          <div className={'small ' + (up && !up.ok ? 'hs-bad' : 'dim')}>{d.upnp ? (up ? (up.ok ? t('host.upnpOk', { ports: upnpPorts(up.mapped) }) : t('host.upnpFail', { detail: up.detail ?? t('host.upnpNoDetail') })) : running ? t('host.upnpPending') : t('host.upnpAtStart')) : t('host.upnpOff', { game: d.ports.game, p2p: d.ports.p2p })}</div>
          {up && !up.ok && up.serverFallback && <div className="dim small">{t('host.upnpFallback')}</div>}
          <div className="dim small">{t('host.neverXmlrpc', { port: d.ports.xmlrpc })}</div>
        </div>
      </li>
      <li>
        <Mark ok={fw ? fw.exists : null} />
        <div>
          <b>{t('host.stepFirewall')}</b>
          <div className="dim small">{t('host.firewallHelp')}</div>
          {fw?.supported && !fw.exists && <div className="small hs-bad">{t('host.firewallMissing', { game: d.ports.game })}</div>}
          {fw?.supported && (
            <>
              <pre className="hs-cmd">{fw.command}</pre>
              <div className="row-btns">
                <button className="btn ghost sm" disabled={fw.exists} onClick={() => host.firewallAdd(d.id).then((ok) => setFw({ ...fw, exists: ok }), (e) => hub.toast({ message: err(e), ok: false }))}>{t('host.allow')}</button>
                <button className="btn ghost sm" onClick={() => host.firewall(d.id).then(setFw)}>{t('host.check')}</button>
              </div>
            </>
          )}
        </div>
      </li>
      {__RELEASE_PREVIEW__ ? (
        // Launcher Preview: no hub, so no test from outside and no public list; a friend's join is the test.
        <li>
          <Mark ok={null} />
          <div>
            <b>{t('host.stepTest')}</b>
            <div className="dim small">{t('host.testFriend', { port: d.ports.game })}</div>
          </div>
        </li>
      ) : <>
      <li>
        <Mark ok={reach ? reach.verdict === 'reachable' : null} />
        <div>
          <b>{t('host.stepTest')}</b>
          <div className="dim small">{t('host.testHelp')}</div>
          <div className="row-btns">
            <button className="btn ghost sm" disabled={!running || testing} title={running ? undefined : t('host.notRunning')} onClick={test}>{testing ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}{t('host.check')}</button>
          </div>
          {reach && <div className={'small ' + (reach.verdict === 'reachable' ? 'hs-ok' : 'hs-bad')}>{t('host.reach.' + reach.verdict, { ip: reach.publicIp ?? '', port: d.ports.game })}</div>}
          {reach?.verdict === 'reachable' && <div className="dim small">{t('host.udpNote')}</div>}
        </div>
      </li>
      <li>
        <Mark ok={d.listing.hubId ? true : null} />
        <div>
          <b>{t('host.stepList')}</b>
          {d.listing.hubId ? (
            <>
              <div className="dim small">{t('host.listed', { address: d.listing.address ?? '' })}</div>
              <div className="hs-row">
                <input className="text-in mono grow" placeholder="tmhs_..." value={token} onChange={(e) => setToken(e.target.value)} />
                <button className="btn ghost sm" disabled={!token.startsWith('tmhs_')} onClick={() => host.save(d, { hubToken: token }).then(() => { setToken(''); reload(); hub.toast({ message: t('host.saved'), ok: true }); }, (e) => hub.toast({ message: err(e), ok: false }))}>{t('host.save')}</button>
              </div>
              <div className="dim small">{row.hasToken ? t('host.tokenSaved') : t('host.tokenHelp')}</div>
              <button className="btn ghost sm danger" onClick={() => host.listingWithdraw(d.id).then(reload)}>{t('host.unlist')}</button>
            </>
          ) : (
            <>
              <div className="dim small">{t('host.listHelp')}</div>
              <label className="hs-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {t('host.consent')}</label>
              <div className="hs-row">
                <input className="text-in grow" placeholder={t('host.contact')} value={contact} onChange={(e) => setContact(e.target.value)} />
                <button className="btn ghost sm" disabled={!consent || contact.trim().length < 3 || reach?.verdict !== 'reachable' || !hubUrl}
                  onClick={() => host.listingSubmit(d.id, hubUrl, contact).then(() => { reload(); hub.toast({ message: t('host.submitted'), ok: true }); }, (e) => hub.toast({ message: err(e), ok: false }))}><Globe size={14} />{t('host.submit')}</button>
              </div>
              <div className="dim small">{t('host.contactHint')}</div>
            </>
          )}
        </div>
      </li>
      </>}
    </ol>
  );
}

/** Players seen on a server (for the lists), loaded once. */
function useSeen(id: string): SeenPlayer[] {
  const [seen, setSeen] = useState<SeenPlayer[]>([]);
  useEffect(() => { host.seen(id).then(setSeen, () => setSeen([])); }, [id]);
  return seen;
}

// ------------------------------------------------------------------ wizard

const STEPS = ['game', 'name', 'access', 'maps', 'lists', 'internet'] as const;
type Step = (typeof STEPS)[number];

function Wizard({ initial, kinds, isNew, hadAccount, onClose, onSaved }: { initial: ServerDef; kinds: Kind[]; isNew: boolean; hadAccount: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const err = useErr();
  const [d, setD] = useState<ServerDef>(initial);
  const [step, setStep] = useState<Step>(isNew ? 'game' : 'name');
  const [account, setAccount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useSeen(initial.id);
  const k = kinds.find((x) => x.id === d.game);
  const set = (p: Partial<ServerDef>) => setD((x) => ({ ...x, ...p }));
  const needLogin = !!k && (d.internet ? k.loginForInternet : k.loginForLan);
  const problems: Partial<Record<Step, string>> = {};
  if (!k || !k.engines.includes(d.engine) || d.engine === 'xaseco') problems.game = t('host.err.engine');
  if (!d.name.replace(/\$([0-9a-f]{1,3}|[a-z$<>]|[lhp]\[[^\]]*\])/gi, '').trim()) problems.name = t('host.err.name');
  if ([d.ports.game, d.ports.p2p, d.ports.xmlrpc].some((p) => !isValidPort(p)) || new Set([d.ports.game, d.ports.p2p, d.ports.xmlrpc]).size < 3) problems.access = t('host.err.ports');
  if (/\s/.test(d.password + d.specPassword)) problems.access = t('host.err.password');
  if (d.engine !== 'randomizer' && d.maps.length === 0) problems.maps = t('host.err.maps');
  if (needLogin && (!isValidLogin(d.serverLogin) || (!account && !hadAccount))) problems.internet = t('host.err.needLogin');
  const i = STEPS.indexOf(step);
  const save = async () => {
    const first = STEPS.find((s) => problems[s]);
    if (first) { setStep(first); setError(problems[first]!); return; }
    setSaving(true); setError(null);
    try { await host.save(d, account ? { account } : undefined); onSaved(); } catch (e) { setError(err(e)); } finally { setSaving(false); }
  };
  return (
    <Modal wide title={isNew ? t('host.wizNew') : t('host.wizEdit')} onClose={onClose}
      actions={<>
        <span className="hs-error grow">{error ?? problems[step] ?? ''}</span>
        {i > 0 && <button className="btn ghost" onClick={() => setStep(STEPS[i - 1])}>{t('host.back')}</button>}
        {i < STEPS.length - 1 && <button className="btn ghost" onClick={() => setStep(STEPS[i + 1])}>{t('host.next')}</button>}
        <button className="btn primary" disabled={saving} onClick={save}>{saving && <Loader2 size={14} className="spin" />}{t('host.save')}</button>
      </>}>
      <div className={'hs-wiz' + (step === 'maps' ? ' hs-wiz-maps' : '')}>
        <nav className="hs-wiz-steps">
          {STEPS.map((s, n) => <button key={s} className={(s === step ? 'on ' : '') + (problems[s] ? 'bad' : '')} onClick={() => setStep(s)}><span>{n + 1}</span>{t('host.wiz.' + s)}</button>)}
        </nav>
        <div className="hs-wiz-body">
          {step === 'game' && <StepGame d={d} set={set} kinds={kinds} />}
          {step === 'name' && <StepName d={d} set={set} />}
          {step === 'access' && <StepAccess d={d} set={set} />}
          {step === 'maps' && k && <StepMaps d={d} set={set} kind={k} />}
          {step === 'lists' && (
            <div className="hs-lists">
              <LoginList title={t('host.guests')} hint={t('host.guestsHint')} items={d.guests} onChange={(guests) => set({ guests })} seen={seen} />
              <LoginList title={t('host.blacklist')} hint={t('host.blacklistHint')} items={d.blacklist} onChange={(blacklist) => set({ blacklist })} seen={seen} />
              <LoginList title={t('host.admins')} hint={d.engine === 'randomizer' ? t('host.adminsHintRandomizer') : t('host.adminsHint')} items={d.admins} onChange={(admins) => set({ admins })} seen={seen} />
            </div>
          )}
          {step === 'internet' && k && <StepInternet d={d} set={set} kind={k} account={account} setAccount={setAccount} hadAccount={hadAccount} />}
        </div>
      </div>
    </Modal>
  );
}

type SetFn = (p: Partial<ServerDef>) => void;

function StepGame({ d, set, kinds }: { d: ServerDef; set: SetFn; kinds: Kind[] }) {
  const t = useT();
  const k = kinds.find((x) => x.id === d.game);
  const engines = ['plain', 'randomizer', 'xaseco'];
  return (
    <div className="hs-form">
      <div className="field">
        <span className="hs-label">{t('host.game')}</span>
        <div className="hs-games">
          {kinds.map((g) => (
            <button key={g.id} className={'hs-game' + (g.id === d.game ? ' on' : '')} onClick={() => set({ game: g.id, engine: g.engines.includes(d.engine) ? d.engine : 'plain', maps: g.id === d.game ? d.maps : [] })}>
              <GameChip id={CHIP[g.id] ?? g.id} />
              <span className="small">{g.label}</span>
              {g.status === 'experimental' && <span className="pill tiny warn">{t('host.experimental')}</span>}
            </button>
          ))}
        </div>
        {k?.status === 'experimental' && <div className="dim small">{t('host.experimentalHelp')}</div>}
      </div>
      <div className="field">
        <span className="hs-label">{t('host.engineLabel')}</span>
        {engines.map((e) => {
          const ok = !!k?.engines.includes(e) && e !== 'xaseco';
          return (
            <label key={e} className={'hs-engine' + (d.engine === e ? ' on' : '') + (ok ? '' : ' off')}>
              <input type="radio" name="engine" disabled={!ok} checked={d.engine === e} onChange={() => set({ engine: e })} />
              <div>
                <b>{t('host.engine.' + e)}</b>
                <div className="dim small">{t('host.engineText.' + e)}</div>
                {e === 'xaseco' && <div className="small hs-warn">{t('host.xasecoBlocked')}</div>}
                {e === 'randomizer' && k?.engines.includes(e) && <div className="dim small">{t('host.randomizerLicence')}</div>}
                {!k?.engines.includes(e) && e !== 'xaseco' && <div className="dim small">{t('host.engineNotForGame')}</div>}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function StepName({ d, set }: { d: ServerDef; set: SetFn }) {
  const t = useT();
  const nameRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="hs-form">
      <div className="field">
        <span className="hs-label">{t('host.name')}</span>
        <TmFormatBar value={d.name} onChange={(name) => set({ name })} inputRef={nameRef} />
        <input ref={nameRef} className="text-in mono" maxLength={75} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="$s$0bfMy $fffServer" />
        <TmPreview text={d.name} kind="name" />
      </div>
      <div className="field">
        <span className="hs-label">{t('host.comment')}</span>
        <TmFormatBar value={d.comment} onChange={(comment) => set({ comment })} inputRef={commentRef} />
        <textarea ref={commentRef} className="text-in mono" rows={3} maxLength={250} value={d.comment} onChange={(e) => set({ comment: e.target.value })} />
        <TmPreview text={d.comment} kind="comment" />
      </div>
    </div>
  );
}

function LabelToggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return <div className="hs-toggle"><span>{label}</span><Toggle on={on} onChange={onChange} label={label} /></div>;
}

function NumberIn({ value, onChange, min, max }: { value: number; onChange: (n: number) => void; min: number; max: number }) {
  return <input type="number" className="text-in hs-num" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />;
}

function StepAccess({ d, set }: { d: ServerDef; set: SetFn }) {
  const t = useT();
  return (
    <div className="hs-form">
      <div className="field">
        <span className="hs-label">{t('host.where')}</span>
        <div className="seg small-seg">
          <button className={!d.internet ? 'on' : ''} onClick={() => set({ internet: false })}>{t('host.lan')}</button>
          <button className={d.internet ? 'on' : ''} onClick={() => set({ internet: true })}>{t('host.internet')}</button>
        </div>
        <span className="dim small">{d.internet ? t('host.internetHelp') : t('host.lanHelp')}</span>
      </div>
      <div className="hs-grid2">
        <label className="field"><span className="hs-label">{t('host.password')}</span><input className="text-in" value={d.password} onChange={(e) => set({ password: e.target.value })} placeholder={t('host.passwordNone')} /></label>
        <label className="field"><span className="hs-label">{t('host.specPassword')}</span><input className="text-in" value={d.specPassword} onChange={(e) => set({ specPassword: e.target.value })} placeholder={t('host.passwordNone')} /></label>
        <label className="field"><span className="hs-label">{t('host.maxPlayers')}</span><NumberIn value={d.maxPlayers} min={1} max={250} onChange={(maxPlayers) => set({ maxPlayers })} /></label>
        <label className="field"><span className="hs-label">{t('host.maxSpectators')}</span><NumberIn value={d.maxSpectators} min={0} max={250} onChange={(maxSpectators) => set({ maxSpectators })} /></label>
      </div>
      <div className="field">
        <span className="hs-label">{t('host.ports')}</span>
        <div className="hs-grid3">
          <label className="field"><span className="dim small">{t('host.portGame')}</span><NumberIn value={d.ports.game} min={1024} max={65535} onChange={(game) => set({ ports: { ...d.ports, game } })} /></label>
          <label className="field"><span className="dim small">{t('host.portP2p')}</span><NumberIn value={d.ports.p2p} min={1024} max={65535} onChange={(p2p) => set({ ports: { ...d.ports, p2p } })} /></label>
          <label className="field"><span className="dim small">{t('host.portXmlrpc')}</span><NumberIn value={d.ports.xmlrpc} min={1024} max={65535} onChange={(xmlrpc) => set({ ports: { ...d.ports, xmlrpc } })} /></label>
        </div>
        <span className="dim small">{t('host.portsHelp')}</span>
      </div>
    </div>
  );
}

/** "100tmx_tmuf_snow" -> "Unfinished TMX maps, Snow", "tech_tmnf" -> "All TMX maps: Tech" (the 100% TMX server's
 * presets: 100tmx = maps nobody has finished, the genre presets draw from every TMX map of that genre). */
function presetLabel(id: string, t: (k: string) => string): string {
  const m = /^(.+?)_(tmnf|tmuf|tmn)(?:_([a-z]+))?$/.exec(id);
  if (!m) return id;
  const key = 'host.presetName.' + m[1];
  const name = t(key);
  if (name === key) return id;
  return m[3] ? `${name}, ${m[3][0].toUpperCase()}${m[3].slice(1)}` : name;
}

function StepMaps({ d, set, kind }: { d: ServerDef; set: SetFn; kind: Kind }) {
  const t = useT();
  const modes = kind.matchStyle === 'script' ? MODES_SCRIPT : MODES_LEGACY;
  const m = d.match;
  const setM = (p: Partial<ServerDef['match']>) => set({ match: { ...m, ...p } });
  if (d.engine === 'randomizer') {
    // The plain 100tmx_<game> preset is the default entry already.
    const presets = (RANDOMIZER_PRESETS[d.game] ?? []).filter((p) => !/^100tmx_(tmnf|tmuf|tmn)$/.test(p));
    return (
      <div className="hs-form">
        <div className="dim small">{t('host.randomizerMaps')}</div>
        <div className="hs-grid2">
          <label className="field"><span className="hs-label">{t('host.preset')}</span>
            <select className="text-in" value={/^100tmx_(tmnf|tmuf|tmn)$/.test(d.randomizer.preset) ? '' : d.randomizer.preset} onChange={(e) => set({ randomizer: { ...d.randomizer, preset: e.target.value } })}>
              <option value="">{t('host.presetDefault')}</option>
              {presets.map((p) => <option key={p} value={p}>{presetLabel(p, t)}</option>)}
            </select>
          </label>
          <label className="field"><span className="hs-label">{t('host.autoSkip')}</span>
            <select className="text-in" value={d.randomizer.autoSkip || 'AuthorMedal'} onChange={(e) => set({ randomizer: { ...d.randomizer, autoSkip: e.target.value } })}>
              {AUTO_SKIP.map((a) => <option key={a} value={a}>{t('host.skip.' + a)}</option>)}
            </select>
          </label>
          <label className="field"><span className="hs-label">{t('host.sessionMinutes')}</span><NumberIn value={d.randomizer.timeLimitMin} min={0} max={1440} onChange={(timeLimitMin) => set({ randomizer: { ...d.randomizer, timeLimitMin } })} /></label>
        </div>
      </div>
    );
  }
  return (
    <div className="hs-form">
      <div className="hs-grid3">
        <label className="field"><span className="hs-label">{t('host.mode')}</span>
          <select className="text-in" value={m.mode} onChange={(e) => setM({ mode: e.target.value })}>
            {modes.map((x) => <option key={x} value={x}>{t('host.mode.' + x)}</option>)}
          </select>
        </label>
        {(m.mode === 'ta' || m.mode === 'laps' || m.mode === 'stunts') && <label className="field"><span className="hs-label">{t('host.timeLimit')}</span><NumberIn value={m.timeLimitS} min={0} max={7200} onChange={(timeLimitS) => setM({ timeLimitS })} /></label>}
        {(m.mode === 'rounds' || m.mode === 'team' || m.mode === 'cup') && <label className="field"><span className="hs-label">{t('host.pointsLimit')}</span><NumberIn value={m.pointsLimit} min={1} max={1000} onChange={(pointsLimit) => setM({ pointsLimit })} /></label>}
        {(m.mode === 'cup' || (kind.matchStyle === 'script' && m.mode === 'rounds')) && <label className="field"><span className="hs-label">{t('host.rounds')}</span><NumberIn value={m.rounds} min={1} max={50} onChange={(rounds) => setM({ rounds })} /></label>}
        {m.mode === 'laps' && <label className="field"><span className="hs-label">{t('host.laps')}</span><NumberIn value={m.laps} min={1} max={100} onChange={(laps) => setM({ laps })} /></label>}
      </div>
      <MapPicker d={d} set={set} kind={kind} />
    </div>
  );
}

function StepInternet({ d, set, kind, account, setAccount, hadAccount }: { d: ServerDef; set: SetFn; kind: Kind; account: string; setAccount: (s: string) => void; hadAccount: boolean }) {
  const t = useT();
  const need = d.internet ? kind.loginForInternet : kind.loginForLan;
  return (
    <div className="hs-form">
      {!need && !d.internet && <div className="notice slim"><Wifi size={16} /><div className="small">{t('host.lanNoLogin')}</div></div>}
      {need && (
        <ol className="hs-steps">
          <li>
            <span className="hs-mark">1</span>
            <div>
              <b>{t('host.stepAccount')}</b>
              <div className="dim small">{kind.loginPage ? t('host.accountHelpNew') : t('host.accountHelpTmf')}</div>
              {kind.loginPage && <button className="btn ghost sm" onClick={() => backend.openExternal?.(kind.loginPage!)}><ExternalLink size={14} />{t('host.openAccountPage')}</button>}
            </div>
          </li>
          <li>
            <span className="hs-mark">2</span>
            <div className="hs-grid2">
              <label className="field"><span className="hs-label">{t('host.serverLogin')}</span><input className="text-in mono" value={d.serverLogin} onChange={(e) => set({ serverLogin: e.target.value.trim() })} autoComplete="off" /></label>
              <label className="field"><span className="hs-label">{t('host.serverPassword')}</span><input className="text-in" type="password" value={account} onChange={(e) => setAccount(e.target.value)} placeholder={hadAccount ? t('host.keepPassword') : ''} autoComplete="new-password" /></label>
              {d.game === 'tmuf' && <label className="field"><span className="hs-label">{t('host.validationKey')}</span><input className="text-in mono" value={d.validationKey} onChange={(e) => set({ validationKey: e.target.value.trim() })} autoComplete="off" /></label>}
            </div>
          </li>
          <li>
            <span className="hs-mark">3</span>
            <div className="dim small">{d.serverLogin && !isValidLogin(d.serverLogin) ? <span className="hs-error">{t('host.err.serverLogin')}</span> : t('host.loginCheckLater')}</div>
          </li>
        </ol>
      )}
      <div className="dim small">{t('host.passwordStore')}</div>
      {d.internet && <LabelToggle on={d.upnp} onChange={() => set({ upnp: !d.upnp })} label={t('host.upnp')} />}
      {d.internet && <div className="dim small">{t('host.upnpHelp', { game: d.ports.game, p2p: d.ports.p2p })}</div>}
      <LabelToggle on={d.autostart} onChange={() => set({ autostart: !d.autostart })} label={t('host.autostart')} />
      <div className="dim small">{t('host.autostartHelp')}</div>
    </div>
  );
}

/** The question when the window is closed while servers run. Mounted once in App. */
export function HostCloseDialog() {
  const t = useT();
  const [n, setN] = useState(0);
  useEffect(() => host.onCloseAsk(setN), []);
  if (!n) return null;
  return (
    <Modal title={t('host.closeTitle')} onClose={() => setN(0)}
      actions={<>
        <button className="btn ghost" onClick={() => setN(0)}>{t('common.cancel')}</button>
        <button className="btn ghost danger" onClick={() => { setN(0); void host.closeChoice('stop'); }}>{t('host.closeStop')}</button>
        <button className="btn primary" onClick={() => { setN(0); void host.closeChoice('keep'); }}>{t('host.closeKeep')}</button>
      </>}>
      {t('host.closeText', { n })}
    </Modal>
  );
}
