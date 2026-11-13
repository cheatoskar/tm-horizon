// Shareable packs: export a profile as a tmhub://pack/ link or .tmhubpack file, import one with
// a check of every mod (installed, downloadable with SHA-256, or not available) before anything
// is installed. The backend (src-tauri/src/packs.rs) encodes, checks and installs.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Download, FileDown, FileUp, Link2, Loader2, Package, ShieldCheck, XCircle } from 'lucide-react';
import { backend, type Pack, type PackCheck } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';
import type { Profile } from '../data/types';

const FOREVER = (g: string) => g === 'tmnf' || g === 'tmuf';

export function ExportPackDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const game = profile.game === 'forever' ? (FOREVER(hub.selectedGame) ? hub.selectedGame : 'tmuf') : profile.game;
  const [servers, setServers] = useState<Record<string, string[]>>({});
  const [tmvs, setTmvs] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { backend.modServers?.().then(setServers).catch(() => {}); }, []);
  const hasTmvs = profile.mods.some((m) => m.id === 'TM Vibrant Shaders');

  const pack: Pack = useMemo(() => ({
    tmhub: 'pack', v: 1, name: profile.name, game,
    program: profile.programVersion ?? null,
    args: profile.args || null,
    mods: profile.mods.map((m) => {
      const mv = hub.mods.find((x) => x.id === m.id);
      return { id: m.id, version: m.version ?? mv?.installedLatest ?? mv?.latest ?? null, server: servers[m.id]?.[0] ?? mv?.remote?.servers[0] ?? null };
    }),
    tmvs: hasTmvs && tmvs.trim() ? tmvs.trim() : null,
  }), [profile, game, servers, tmvs, hasTmvs, hub.mods]);

  useEffect(() => {
    setError(null);
    backend.packs?.encode(pack).then(setLink).catch((e) => { setLink(null); setError(String(e)); });
  }, [pack]);

  return (
    <Modal title={<><Package size={18} /> {t('pack.exportTitle', { name: profile.name })}</>} onClose={onClose}
      actions={<>
        <button className="btn ghost" onClick={async () => {
          const p = await backend.packs?.saveFile(pack).catch((e) => { hub.toast({ message: String(e), ok: false }); return null; });
          if (p) hub.toast({ message: t('pack.fileSaved', { path: p }), actions: [{ label: t('common.show'), run: () => backend.reveal?.(p) }] });
        }}><FileDown size={15} /> {t('pack.saveFile')}</button>
        <div className="grow" />
        <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        <button className="btn primary" disabled={!link} onClick={() => { navigator.clipboard?.writeText(link!).catch(() => {}); hub.toast({ message: t('common.copied') }); }}><Copy size={15} /> {t('pack.copyLink')}</button>
      </>}>
      <p className="dim small">{t('pack.exportIntro')}</p>
      <ul className="pack-mods">
        {pack.mods.map((m) => (
          <li key={m.id}><b>{m.id}</b><span className="mono small">{m.version ?? t('pack.anyVersion')}</span><span className="dim small ellip">{m.server ? new URL(m.server).host : t('pack.noServer')}</span></li>
        ))}
        {pack.mods.length === 0 && <li className="dim small">{t('pack.noMods')}</li>}
      </ul>
      {hasTmvs && (
        <label className="field">
          <span className="small">{t('pack.tmvsCode')}</span>
          <input className="text-in mono" value={tmvs} onChange={(e) => setTmvs(e.target.value)} placeholder={t('pack.tmvsHint')} spellCheck={false} />
        </label>
      )}
      {link && <code className="pack-link" title={link}><Link2 size={13} /> {link}</code>}
      {error && <p className="warn small">{error}</p>}
    </Modal>
  );
}

/** Paste a link or open a file, then check and import. */
export function ImportPackDialog({ initial, onClose }: { initial?: Pack | null; onClose: () => void }) {
  const hub = useHubState();
  const t = useT();
  const [text, setText] = useState('');
  const [pack, setPack] = useState<Pack | null>(initial ?? null);
  const [check, setCheck] = useState<PackCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pack || !backend.packs) return;
    setCheck(null);
    backend.packs.check(pack).then(setCheck).catch((e) => setError(String(e)));
  }, [pack]);

  const read = async () => {
    setError(null);
    try { setPack(await backend.packs!.decode(text)); } catch (e) { setError(String(e)); }
  };
  const open = async () => {
    setError(null);
    try { const p = await backend.packs!.openFile(); if (p) setPack(p); } catch (e) { setError(String(e)); }
  };
  const doImport = async () => {
    if (!pack) return;
    setBusy(true);
    try {
      const r = await backend.packs!.import(pack);
      hub.toast(r);
      if (r.ok) onClose();
    } catch (e) { setError(String(e)); }
    setBusy(false);
  };

  const status = (s: string) => {
    switch (s) {
      case 'installed': return <span className="small good"><CheckCircle2 size={13} /> {t('pack.st.installed')}</span>;
      case 'download': return <span className="small acc-text"><ShieldCheck size={13} /> {t('pack.st.download')}</span>;
      case 'other': return <span className="small dim">{t('pack.st.other')}</span>;
      default: return <span className="small warn"><XCircle size={13} /> {t('pack.st.' + s)}</span>;
    }
  };

  return (
    <Modal title={<><Package size={18} /> {pack ? t('pack.importTitle', { name: pack.name }) : t('pack.importPack')}</>} onClose={onClose}
      actions={<>
        <div className="grow" />
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        {pack && <button className="btn primary" disabled={!check?.canImport || busy} onClick={doImport}>{busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {t('pack.import')}</button>}
      </>}>
      {!pack && (
        <>
          <p className="dim small">{t('pack.importIntro')}</p>
          <div className="setrow">
            <input className="text-in mono grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="tmhub://pack/…" spellCheck={false} />
            <button className="btn ghost sm" disabled={!text.trim()} onClick={read}>{t('pack.read')}</button>
            <button className="btn ghost sm" onClick={open}><FileUp size={14} /> {t('pack.openFile')}</button>
          </div>
        </>
      )}
      {pack && (
        <>
          <dl className="kv">
            <dt>{t('pack.game')}</dt><dd>{hub.game(pack.game === 'tmn-eswc' ? 'tmn-eswc' : pack.game)?.name ?? pack.game}</dd>
            {pack.program && <><dt>{t('pack.program')}</dt><dd className="mono">{pack.program}</dd></>}
            {pack.args && <><dt>{t('pack.args')}</dt><dd className="mono">{pack.args}</dd></>}
          </dl>
          {!check && !error && <p className="dim"><Loader2 size={15} className="spin" /> {t('pack.checking')}</p>}
          {check && (
            <ul className="pack-mods">
              {check.mods.map((m) => (
                <li key={m.id} title={m.sha256 ? `SHA-256 ${m.sha256}` : undefined}>
                  <b>{m.id}</b><span className="mono small">{m.version ?? ''}</span>
                  <span className="dim small ellip">{m.server ? new URL(m.server).host : ''}</span>{status(m.status)}
                </li>
              ))}
            </ul>
          )}
          {check?.problem && <p className="warn small">{check.problem}</p>}
          {check && <p className="dim small">{check.forever ? t('pack.foreverNote') : t('pack.otherNote')}</p>}
          {pack.tmvs && (
            <div className="setrow">
              <span className="small grow">{t('pack.tmvsImport')}</span>
              <code className="mono small ellip" title={pack.tmvs}>{pack.tmvs}</code>
              <button className="btn icon tiny" title={t('common.copy')} onClick={() => { navigator.clipboard?.writeText(pack.tmvs!).catch(() => {}); hub.toast({ message: t('common.copied') }); }}><Copy size={13} /></button>
            </div>
          )}
        </>
      )}
      {error && <p className="warn small">{error}</p>}
    </Modal>
  );
}
