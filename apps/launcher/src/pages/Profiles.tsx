import { useEffect, useState } from 'react';
import { Bot, Copy, Download, HardDrive, Pencil, Plus, Share2, Star, Trash2 } from 'lucide-react';
import { InstancePanel, NewProfileDialog, instanceGames } from '../ui/Instances';
import { profileFits, tmlName, useHubState } from '../state';
import { backend, isNative, type Pack } from '../data/backend';
import { TAS_TEMPLATE } from './TasCorner';
import { tp, useT } from '../i18n';
import { GameArt, ModIcon, PlayButton, SectionHead, Toggle } from '../ui/common';
import { foreverMods } from './GamePage';
import { OpInstalledPlugins } from './ModSources';
import type { Profile } from '../data/types';

const GROUPS = [
  { key: 'forever', label: 'Nations / United Forever', sub: 'TMLoader', game: 'tmuf' },
  { key: 'tmn-eswc', label: 'Nations ESWC', sub: '', game: 'tmn-eswc' },
  { key: 'tm2-stadium', label: 'TM² Stadium', sub: 'Openplanet', game: 'tm2-stadium' },
  { key: 'tm2-canyon', label: 'TM² Canyon', sub: 'Openplanet', game: 'tm2-canyon' },
  { key: 'tm2020', label: 'Trackmania', sub: 'Openplanet', game: 'tm2020' },
];

const packGroup = (game: string) => (game === 'tmnf' || game === 'tmuf' ? 'forever' : game);

export function Profiles({ initial }: { initial?: string }) {
  const hub = useHubState();
  const t = useT();
  // Forever: TAS mode lists only profiles with TMInterface, play mode never those.
  const tas = hub.mode === 'tas';
  const groups = GROUPS;
  const fits = (p: Profile) => profileFits(p, hub.mode);
  const [group, setGroup] = useState(groups.some((g) => g.key === initial) ? initial! : 'forever');
  const grp = groups.find((g) => g.key === group) ?? groups[0];
  // Packs imported for games without TMLoader live in TM Horizon's own data folder.
  const [packs, setPacks] = useState<Pack[]>([]);
  const loadPacks = () => { backend.packs?.list().then(setPacks).catch(() => {}); };
  useEffect(loadPacks, [hub.dialog]); // eslint-disable-line react-hooks/exhaustive-deps
  const packProfiles: Profile[] = packs.filter((p) => packGroup(p.game) === group && group !== 'forever')
    .map((p) => ({ id: 'pack:' + p.name, game: group, name: p.name, mods: p.mods.map((m) => ({ id: m.id, version: m.version ?? null })), real: false }));
  const list = [...hub.profiles.filter((p) => p.game === group && fits(p)), ...packProfiles];
  const createTas = async () => {
    const r = await backend.profileCreate!(TAS_TEMPLATE.name, TAS_TEMPLATE.mods);
    hub.toast(r);
    if (r.ok && r.command) { setSelId('tml:' + r.command); hub.selectProfile('forever', 'tml:' + r.command); }
  };
  const [selId, setSelId] = useState<string | null>(null);
  const sel = list.find((p) => p.id === selId) ?? hub.profileFor(grp.game) ?? list[0] ?? null;
  const defName = hub.snapshot.tmloader.defaultProfiles?.TmForever;
  const selInst = sel?.instance ? hub.instances.find((i) => i.id === sel.instance) ?? null : null;
  const pick = (id: string | null) => { setSelId(id); if (id) hub.selectProfile(group, id); };

  const freeName = (baseName: string) => {
    let n = 1;
    let name = baseName;
    while (list.some((p) => p.name === name)) name = `${baseName} ${++n}`;
    return name;
  };
  const [newOpen, setNewOpen] = useState(false);
  // In the app a Forever profile is a real TMLoader profile; the other games have one fixed profile
  // and get new ones only as separate installations (NewProfileDialog). The browser preview keeps
  // unsaved sample profiles.
  const realProfiles = isNative && group === 'forever' && !!backend.profileCreate && hub.snapshot.tmloader.installed;
  const create = async (base?: Profile, typed?: string) => {
    const name = typed ?? freeName(base ? t('profiles.copyName', { name: base.name }) : t('profiles.newName'));
    if (realProfiles) {
      const r = await backend.profileCreate!(name, base ? base.mods.map((m) => m.id) : [],
        base ? { versions: base.mods.map((m) => m.version), programVersion: base.programVersion, args: base.args } : undefined);
      if (!r.ok || !r.command) { hub.toast({ ok: false, message: r.message }); return; }
      pick('tml:' + r.command);
      hub.toast({ ok: true, message: t('inst.created', { name: r.command }) });
      return;
    }
    const p: Profile = { id: 'new:' + Date.now(), game: group, name, mods: base ? [...base.mods] : [], real: false, args: base?.args };
    hub.setProfiles([...hub.profiles, p]);
    setSelId(p.id);
    hub.toast({ message: base ? t('profiles.dupToast', { name }) : t('profiles.createdToast', { name }) });
  };
  const remove = (p: Profile) => {
    if (p.id.startsWith('pack:')) { backend.packs?.remove(p.name).then(loadPacks); setSelId(null); return; }
    const tml = isNative ? tmlName(p) : null;
    if (tml && backend.profileDelete) {
      hub.setConfirm({
        title: t('inst.deleteTitle', { name: tml }), ok: t('common.delete'), cancel: t('common.cancel'),
        text: t('profiles.deleteText'),
        onOk: async () => {
          const r = await backend.profileDelete!(tml);
          if (!r.ok) { hub.toast({ ok: false, message: r.message }); return; }
          setSelId(null);
          hub.toast({ ok: true, message: t('inst.deleted', { name: tml }) });
        },
      });
      return;
    }
    hub.setProfiles(hub.profiles.filter((x) => x.id !== p.id));
    setSelId(null);
    hub.toast({ message: t('profiles.removedToast', { name: p.name }) });
  };
  // App: built-in profiles ("No mods", the fixed profile of the other games) and TMLoader's default stay.
  const canDelete = (p: Profile) => !isNative || p.id.startsWith('pack:') || p.id.startsWith('new:') || (!!tmlName(p) && p.name !== defName);
  const canDuplicate = (p: Profile) => !isNative || (group === 'forever' && realProfiles);
  const canNew = !isNative || group === 'forever' || instanceGames(group).length > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('nav.profiles')}</h1>
          <span className="dim">{tas && group === 'forever' ? t('tas.profilesSub') : t('profiles.sub')}</span>
        </div>
      </div>
      <div className="prof-grid">
        <div className="prof-groups">
          {groups.map((g) => {
            const n = hub.profiles.filter((p) => p.game === g.key && fits(p)).length;
            return (
              <button key={g.key} className={'pg' + (g.key === group ? ' on' : '')} onClick={() => { setGroup(g.key); setSelId(null); }}>
                <GameArt game={hub.game(g.game)} variant="cover" className="pg-art" />
                <span className="pg-text">
                  <b className="ellip" title={g.label}>{g.label}</b>
                  <span className="dim small">{g.sub || t('common.noMods')} · {n}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="prof-list panel">
          <SectionHead title={t('profiles.list')} right={<>
            {isNative && !(tas && group === 'forever') && <button className="btn ghost sm" onClick={() => hub.setDialog({ kind: 'import' })} title={t('pack.importTip')}><Download size={15} /> {t('pack.importBtn')}</button>}
            {!(tas && group === 'forever') && canNew && <button className="btn ghost sm" onClick={() => setNewOpen(true)} title={t('profiles.newTip')}><Plus size={15} /> {t('profiles.new')}</button>}
          </>} />
          {list.map((p) => (
            <button key={p.id} className={'prow' + (p.id === sel?.id ? ' on' : '')} onClick={() => { setSelId(p.id); hub.selectProfile(group, p.id); }}>
              <span className="grow">
                <b>{p.name}</b>
                {group === 'forever' && p.name === defName && <span className="pill tiny"><Star size={10} /> {t('profiles.default')}</span>}
                {p.instance && <span className="pill tiny" title={t('inst.separateTip')}><HardDrive size={10} /> {t('inst.badge')}</span>}
                {!p.real && <span className="pill tiny muted">{p.id.startsWith('new:') ? t('profiles.unsaved') : p.id.startsWith('pack:') ? t('profiles.fromPack') : t('profiles.unsaved')}</span>}
              </span>
              <span className="dim small">{tp('common.mods', p.mods.length)}</span>
            </button>
          ))}
          {list.length === 0 && <div className="dim small">{t('profiles.none')}</div>}
          {tas && group === 'forever' && isNative && hub.snapshot.tmloader.installed && (
            <button className="btn ghost tpl-btn" onClick={createTas} title={t('tas.templateTip')}>
              <Bot size={16} />
              <span className="tpl-text"><b>{t('tas.template')}</b><span className="dim small">TMInterface + CoreMod</span></span>
            </button>
          )}
          {group === 'forever'
            ? <p className="dim small foot">{t('profiles.fromTml')}</p>
            : <p className="dim small foot">{t('profiles.onlyForever')}</p>}
        </div>

        {sel && (
          <div className="prof-detail panel">
            <div className="pd-head">
              <div>
                <div className="dim small">{grp.label}</div>
                <h2 className="pd-name">{sel.name} <button className="btn icon tiny" title={t('profiles.rename')} onClick={() => hub.toast({ message: t('profiles.previewRename') })}><Pencil size={13} /></button></h2>
              </div>
              <div className="grow" />
              {isNative && (tmlName(sel) || sel.id.startsWith('pack:')) && <button className="btn ghost sm" onClick={() => hub.setDialog({ kind: 'export', profileId: sel.id })} title={t('pack.shareTip')}><Share2 size={15} /> {t('pack.share')}</button>}
              {!selInst && canDuplicate(sel) && <button className="btn ghost sm" onClick={() => void create(sel)} title={t('profiles.duplicateTip')}><Copy size={15} /> {t('profiles.duplicate')}</button>}
              {!selInst && canDelete(sel) && <button className="btn ghost sm danger" onClick={() => remove(sel)} title={t('profiles.deleteTip')}><Trash2 size={15} /> {t('common.delete')}</button>}
            </div>

            {selInst && <InstancePanel inst={selInst} group={group} copyName={freeName(t('profiles.copyName', { name: selInst.name }))} onSelect={pick} />}
            {group === 'forever' && !selInst && (
              <>
                <div className="pd-meta">
                  <span>{t('pack.program')} <b>{sel.programVersion ?? t('profiles.latest')}</b></span>
                  <span>{t('pack.args')} <b className="mono">{sel.args || t('common.none')}</b></span>
                </div>
                <div className="pd-mods">
                  {foreverMods(hub.mods).map((m) => {
                    const e = sel.mods.find((x) => x.id === m.id);
                    return (
                      <div className="pd-mod" key={m.id}>
                        <ModIcon mod={m} size={32} />
                        <span className="grow"><b>{m.name}</b> <span className="dim small">{e?.version ? t('common.fixedVer', { v: e.version }) : m.installedLatest}</span></span>
                        {m.id === 'CoreMod' ? <span className="dim small">{t('common.auto')}</span> : <Toggle on={hub.modPending(sel.id, m.id) ?? !!e} busy={hub.modPending(sel.id, m.id) !== undefined} label={m.name} onChange={() => hub.toggleMod(sel.id, m.id)} />}
                      </div>
                    );
                  })}
                </div>
                <div className="cmdline block">
                  <span className="dim small">{t('profiles.shortcut')}</span>
                  <code>{hub.commandFor(hub.game('tmuf'), sel)}</code>
                </div>
              </>
            )}
            {(group === 'tm2020' || group.startsWith('tm2-')) && !selInst && (
              <div>
                <OpInstalledPlugins game={grp.game} compact />
                <p className="dim small">{t('op.loadsAll')}</p>
              </div>
            )}
            {group === 'tmn-eswc' && !selInst && <p className="dim">{t('profiles.eswcNone')}</p>}
            <div className="pd-play">
              <PlayButton game={hub.game(selInst?.game ?? grp.game) ?? hub.game(grp.game)} />
            </div>
          </div>
        )}
      </div>
      {newOpen && <NewProfileDialog group={group} defaultName={freeName(t('profiles.newName'))} onPlain={(n) => void create(undefined, n)} onCreated={pick} onClose={() => setNewOpen(false)} />}
    </div>
  );
}
