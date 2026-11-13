// Community page: the Discord server directory kept by mx_eyebo (Mania Exchange), from the hub
// data (communities.json, invite counts checked daily). Join opens the invite in the browser or
// the Discord app; nothing is joined from inside TM Horizon.
import { useMemo, useState } from 'react';
import { ExternalLink, Search, Users } from 'lucide-react';
import { backend } from '../data/backend';
import { TM_WIKI } from '../data/links';
import { communitiesFile } from '../data/hub';
import { timeAgo } from '../data/model';
import { useI18n } from '../i18n';
import { useCachedImage } from '../ui/common';
import type { Community } from '@tm-hub/shared';

const GROUP_ORDER = ['Official', 'Countries & Regions', 'Communities', 'Teams', 'Events', 'Projects', 'Creators', 'People'];
const groupKey = (g: string) => 'communities.group.' + g.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

type CommSort = 'members' | 'online' | 'name' | 'group' | 'checked';
const COMM_SORTS: CommSort[] = ['members', 'online', 'name', 'group', 'checked'];
/** Larger first; entries without a value always come last, whatever the direction. */
const byNum = (a: number | null | undefined, b: number | null | undefined) => (a == null ? 1 : 0) - (b == null ? 1 : 0) || (b ?? 0) - (a ?? 0);
const byName = (a: Community, b: Community) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const groupRank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
/** Sort applied after the filters and the search. */
export function sortCommunities(list: Community[], sort: CommSort): Community[] {
  const cmp: Record<CommSort, (a: Community, b: Community) => number> = {
    members: (a, b) => byNum(a.members, b.members),
    online: (a, b) => byNum(a.online, b.online),
    name: byName,
    group: (a, b) => groupRank(a.group) - groupRank(b.group) || a.section.localeCompare(b.section) || byName(a, b),
    checked: (a, b) => (a.checked == null ? 1 : 0) - (b.checked == null ? 1 : 0) || (b.checked ?? '').localeCompare(a.checked ?? ''),
  };
  return [...list].sort((a, b) => cmp[sort](a, b) || byNum(a.members, b.members) || byName(a, b));
}

function Avatar({ c }: { c: Community }) {
  // The server's own icon from Discord's CDN (cached locally by the app); initials only without one.
  const src = useCachedImage(c.icon ?? null);
  const name = c.guildName ?? c.name;
  if (src) return <img className="comm-ava" src={src} alt="" loading="lazy" />;
  const hue = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  return <span className="comm-ava" style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55%), #0000 140%)` }}>{name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'}</span>;
}

export function Communities() {
  const { t, locale } = useI18n();
  const [group, setGroup] = useState('all');
  const [region, setRegion] = useState('all');
  const [q, setQ] = useState('');
  const [archive, setArchive] = useState(false);
  const [sort, setSort] = useState<CommSort>('members');
  const nf = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }), [locale]);
  const all = communitiesFile.communities;
  const groups = GROUP_ORDER.filter((g) => all.some((c) => c.active && c.group === g));
  const regions = [...new Set(all.filter((c) => c.region).map((c) => c.region!))].sort();
  const label = (g: string) => { const k = groupKey(g); const s = t(k); return s === k ? g : s; };
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const filtered = all
      .filter((c) => (archive ? !c.active : c.active))
      .filter((c) => archive || group === 'all' || c.group === group)
      .filter((c) => group !== 'Countries & Regions' || region === 'all' || c.region === region)
      .filter((c) => !s || [c.name, c.guildName, c.section, c.region].some((x) => x?.toLowerCase().includes(s)));
    return sortCommunities(filtered, sort);
  }, [all, group, region, q, archive, sort]);

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t('nav.community')}</h1>
          <span className="dim">{t('communities.sub', { n: all.filter((c) => c.active).length })} · {t('communities.checked', { ago: timeAgo(communitiesFile.generated) })}</span>
        </div>
      </div>
      <div className="toolbar">
        <label className="search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('communities.search')} />
        </label>
        <label className="select">
          <span className="dim small">{t('communities.sort')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as CommSort)}>
            {COMM_SORTS.map((x) => <option key={x} value={x}>{t('communities.sort.' + x)}</option>)}
          </select>
        </label>
        <div className="chips">
          <button className={'fchip' + (group === 'all' && !archive ? ' on' : '')} onClick={() => { setGroup('all'); setArchive(false); }}>{t('common.all')}</button>
          {groups.map((g) => <button key={g} className={'fchip' + (group === g && !archive ? ' on' : '')} onClick={() => { setGroup(g); setArchive(false); }}>{label(g)}</button>)}
          <button className={'fchip' + (archive ? ' on' : '')} onClick={() => setArchive(!archive)} title={t('communities.archiveTip')}>{t('communities.archive')}</button>
        </div>
      </div>
      {group === 'Countries & Regions' && !archive && (
        <div className="chips sub-chips">
          <button className={'fchip' + (region === 'all' ? ' on' : '')} onClick={() => setRegion('all')}>{t('common.all')}</button>
          {regions.map((r) => <button key={r} className={'fchip' + (region === r ? ' on' : '')} onClick={() => setRegion(r)}>{r}</button>)}
        </div>
      )}
      <div className="comm-grid">
        {list.map((c) => (
          <div className={'comm' + (c.alive === false ? ' dead' : '')} key={c.id}>
            <div className="comm-top">
              <Avatar c={c} />
              <div className="grow min0">
                <b className="ellip" title={c.guildName && c.guildName !== c.name ? c.guildName : c.name}>{c.name}</b>
                <div className="modrow-meta">
                  <span className="pill tiny muted">{label(c.group)}</span>
                  {c.section && c.section !== c.group && <span className="pill tiny muted">{c.region ?? c.section}</span>}
                </div>
              </div>
            </div>
            <div className="comm-foot">
              {c.online != null && <span className="small"><span className="dot on" /> {t('communities.online', { n: nf.format(c.online) })}</span>}
              {c.members != null && <span className="small dim"><Users size={12} /> {nf.format(c.members)}</span>}
              {c.alive === false && <span className="small warn">{t('communities.expired')}</span>}
              <div className="grow" />
              {c.alive !== false && <button className="btn ghost sm" title={c.url} onClick={() => backend.openExternal(c.url)}><ExternalLink size={13} /> {c.invite ? t('communities.join') : t('common.open')}</button>}
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="empty">{t('communities.none')}</div>}
      </div>
      <p className="dim small foot-note">
        <button className="linkish" onClick={() => backend.openExternal(communitiesFile.credit.url)}>{t('communities.credit')}</button> · {t('communities.suggest')} · <button className="linkish" title={TM_WIKI} onClick={() => backend.openExternal(TM_WIKI)}>TrackMania Wiki</button>
      </p>
    </div>
  );
}
