import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Code2, Download, ExternalLink, Loader2, Puzzle, RefreshCw, RotateCw, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import type { CatalogEntry } from '@tm-hub/shared';
import { CATALOG } from '../data/hub';
import { backend, type AddonInstalled, type AddonPlan, type AddonsInfo, type AddonUpdate } from '../data/backend';
import { useT } from '../i18n';
import { useHubState } from '../state';
import { Toggle } from './common';
import { Modal } from './Modal';
import '../styles-addons.css';

// Add-ons panel of the embedded browser (puzzle button, top right of the browser bar). Lists the
// curated browser add-ons from the catalog (category "browser-addon"); installable ones come from
// the author's GitHub release and load into the embedded browser's own profile only
// (src-tauri/src/addons.rs). Store-only ones get their store or source page.

export const ADDONS: CatalogEntry[] = CATALOG.filter((c) => c.category === 'browser-addon' && c.addon);

const shortHash = (h: string) => (h ? h.slice(0, 12) + '…' : '');
const host = (p: string) => (p === '<all_urls>' ? '*' : (p.split('://')[1] ?? p).split('/')[0]);

function AddonIcon({ e }: { e: CatalogEntry }) {
  const [bad, setBad] = useState(false);
  if (e.addon?.icon && !bad) return <img className="addon-ico" src={e.addon.icon} alt="" onError={() => setBad(true)} />;
  return <span className="addon-ico addon-ico-ph"><Puzzle size={20} /></span>;
}

export function AddonsPanel({ onClose, onReload }: { onClose: () => void; onReload: () => void }) {
  const t = useT();
  const hub = useHubState();
  const [info, setInfo] = useState<AddonsInfo | null>(null);
  const [updates, setUpdates] = useState<AddonUpdate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AddonPlan | null>(null);
  const [reloadHint, setReloadHint] = useState(false);
  const [checking, setChecking] = useState(false);
  const api = backend.addons;

  useEffect(() => {
    if (!api) return;
    api.list().then(setInfo).catch((e) => setError(String(e)));
    api.check().then(setUpdates).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (installed: AddonInstalled[]) => setInfo((i) => (i ? { ...i, installed } : i));
  const run = async (id: string, f: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try { await f(); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };
  const prepare = (id: string, dev = false) => run(id, async () => { if (api) setPlan(await api.prepare(id, dev)); });
  const confirm = () => plan && run(plan.id, async () => {
    if (!api) return;
    const p = plan;
    setPlan(null);
    refresh(await api.apply(p.id));
    setUpdates((u) => u.filter((x) => x.id !== p.id));
    setReloadHint(true);
    hub.toast({ message: t(p.update ? 'addons.updated' : 'addons.installed', { name: p.name, version: p.version }) });
  });
  const toggle = (i: AddonInstalled) => run(i.id, async () => { if (api) { refresh(await api.setEnabled(i.id, !i.enabled)); setReloadHint(true); } });
  const remove = (i: AddonInstalled, name: string) => run(i.id, async () => {
    if (!api) return;
    refresh(await api.remove(i.id));
    hub.toast({ message: t('addons.removed', { name }) });
    setReloadHint(true);
  });
  const check = () => {
    if (!api) return;
    setChecking(true);
    api.check().then(setUpdates).catch((e) => setError(String(e))).finally(() => setChecking(false));
  };

  const supported = !!api && (info?.supported ?? true);
  const installable = ADDONS.filter((e) => e.addon!.install === 'github');
  const others = ADDONS.filter((e) => e.addon!.install !== 'github');

  return (
    <>
      <div className="addons-panel" role="dialog" aria-label={t('addons.title')}>
        <div className="addons-head">
          <Puzzle size={18} />
          <div className="grow">
            <b>{t('addons.title')}</b>
            <div className="dim small">{t('addons.sub')}</div>
          </div>
          <button className="bbtn sm" title={t('addons.check')} disabled={!supported || checking} onClick={check}>
            {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
          <button className="bbtn sm" aria-label={t('common.close')} onClick={onClose}><X size={15} /></button>
        </div>

        <div className="addons-body">
          {!api && <div className="addons-note"><AlertTriangle size={15} /> {t('addons.nativeOnly')}</div>}
          {api && info && !info.supported && <div className="addons-note"><AlertTriangle size={15} /> {t('addons.unsupported')}</div>}
          {error && <div className="addons-note bad"><AlertTriangle size={15} /> <span className="grow">{error}</span><button className="bbtn sm" onClick={() => setError(null)}><X size={13} /></button></div>}
          {reloadHint && (
            <div className="addons-note ok">
              <CheckCircle2 size={15} /> <span className="grow">{t('addons.reloadHint')}</span>
              <button className="btn ghost sm" onClick={() => { onReload(); setReloadHint(false); }}><RotateCw size={13} /> {t('web.reload')}</button>
            </div>
          )}

          {installable.map((e) => {
            const a = e.addon!;
            const inst = info?.installed.find((i) => i.id === e.id);
            const upd = updates.find((u) => u.id === e.id && u.update);
            const dev = info?.dev.includes(e.id) && a.devInstall;
            const isBusy = busy === e.id;
            return (
              <div key={e.id} className={'addon-card' + (inst && !inst.enabled ? ' off' : '')}>
                <div className="addon-top">
                  <AddonIcon e={e} />
                  <div className="grow min0">
                    <b className="ellip">{e.name}</b>
                    <div className="dim small ellip">
                      {t('addons.by', { author: e.author ?? e.maintainer ?? '?' })} · {a.licence}
                      {inst && <> · {inst.source.startsWith('dev:') ? t('addons.devBuild', { version: inst.version }) : t('addons.version', { version: inst.version })}</>}
                    </div>
                  </div>
                  {inst && <Toggle on={inst.enabled} busy={isBusy} label={t('addons.enabled')} onChange={() => toggle(inst)} />}
                </div>
                <p className="addon-desc">{e.description}</p>
                <div className="addon-perm"><ShieldCheck size={14} /> <span>{a.permissionsSummary}</span></div>
                {a.note && <div className="addon-limit dim small">{a.note}</div>}
                {upd && <div className="addon-upd"><Download size={13} /> {t('addons.updateTo', { version: upd.latest ?? '' })}</div>}
                <div className="addon-actions">
                  {!inst && <button className="btn primary sm" disabled={!supported || isBusy} onClick={() => prepare(e.id)}>
                    {isBusy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t('addons.install')}</button>}
                  {inst && upd && <button className="btn primary sm" disabled={!supported || isBusy} onClick={() => prepare(e.id)}>
                    {isBusy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t('addons.update')}</button>}
                  {dev && <button className="btn ghost sm" disabled={!supported || isBusy} onClick={() => prepare(e.id, true)} title={t('addons.devTip')}><Code2 size={14} /> {t('addons.devInstall')}</button>}
                  {inst && <button className="btn ghost sm" disabled={isBusy} onClick={() => remove(inst, e.name)}><Trash2 size={14} /> {t('common.remove')}</button>}
                  <span className="grow" />
                  {e.url && <button className="btn ghost sm" onClick={() => backend.openExternal(e.url!)}><ExternalLink size={13} /> {t('addons.source')}</button>}
                </div>
              </div>
            );
          })}

          {others.length > 0 && <div className="addons-sep">{t('addons.others')}</div>}
          {others.map((e) => {
            const a = e.addon!;
            const store = a.stores.chrome ?? a.stores.edge ?? a.stores.firefox;
            return (
              <div key={e.id} className="addon-card store">
                <div className="addon-top">
                  <AddonIcon e={e} />
                  <div className="grow min0">
                    <b className="ellip">{e.name}</b>
                    <div className="dim small ellip">{t('addons.by', { author: e.author ?? e.maintainer ?? '?' })} · {a.licence}</div>
                  </div>
                  <span className="pill tiny muted" title={t(a.compatible ? 'addons.notInstallable' : 'addons.incompatible')}>{t('addons.linkOnly')}</span>
                </div>
                <p className="addon-desc">{e.description}</p>
                <div className="addon-perm"><ShieldAlert size={14} /> <span>{a.permissionsSummary}</span></div>
                {a.note && <div className="addon-limit dim small">{a.note}</div>}
                <div className="addon-actions">
                  <span className="dim small grow">{t(a.redistribution ? 'addons.notInstallable' : 'addons.noRedistribution')}</span>
                  {store
                    ? <button className="btn ghost sm" onClick={() => backend.openExternal(store)}><ExternalLink size={13} /> {t('addons.store')}</button>
                    : e.url && <button className="btn ghost sm" onClick={() => backend.openExternal(e.url!)}><ExternalLink size={13} /> {t('addons.source')}</button>}
                </div>
              </div>
            );
          })}
          <p className="addons-foot dim small">{t('addons.limits')}</p>
        </div>
      </div>

      {plan && (
        <Modal title={t(plan.update ? 'addons.confirmUpdate' : 'addons.confirmTitle', { name: plan.name })} onClose={() => setPlan(null)} actions={<>
          <button className="btn ghost" onClick={() => setPlan(null)}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={confirm}>{t(plan.update ? 'addons.update' : 'addons.install')}</button>
        </>}>
          <p className="small">{t('addons.confirmText', { version: plan.version })}</p>
          <div className="addon-plan">
            <div><span className="dim">{t('addons.from')}</span> <span className="mono">{plan.source.replace(/^github:/, 'github.com/').replace(/^dev:/, '')}</span></div>
            <div><span className="dim">{t('addons.file')}</span> <span className="mono">{plan.file}</span>{plan.tag && <> · {plan.tag}</>}</div>
            <div><span className="dim">SHA-256</span> <span className="mono" title={plan.sha256}>{shortHash(plan.sha256)}</span>
              {' '}<span className={'pill tiny' + (plan.verified === 'github-digest' || plan.verified === 'sha256sums' ? ' ok' : ' muted')}>{t('addons.verified.' + plan.verified)}</span></div>
          </div>
          <h4 className="addon-plan-h">{t('addons.asks')}</h4>
          <ul className="addon-perms">
            {plan.permissions.map((p) => <li key={p}><code>{p}</code> {t('addons.perm.' + p) !== 'addons.perm.' + p ? <span className="dim small">{t('addons.perm.' + p)}</span> : null}</li>)}
            {[...new Set(plan.hosts.map(host))].map((h) => <li key={h}><code>{h}</code> <span className="dim small">{t(h === '127.0.0.1' ? 'addons.hostLocal' : 'addons.hostSite')}</span></li>)}
          </ul>
          {plan.extra.length > 0 && (
            <div className="addons-note bad"><ShieldAlert size={15} /> {t('addons.extra', { list: plan.extra.join(', ') })}</div>
          )}
          <p className="dim small">{t('addons.profileOnly')}</p>
        </Modal>
      )}
    </>
  );
}
