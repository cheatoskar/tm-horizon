// A mod's showcase page inside the launcher: the shared renderer with the launcher's hooks (cached
// pictures, links through the embedded browser or the system browser, install through the page's own
// install button, changelog from the mod's versions or its GitHub releases).
import { useMemo, useState } from 'react';
import { ShowcaseView, type ShowcaseCtx, type ShowcaseLabels, type ShowcaseRelease } from '@tm-hub/showcase-ui';
import '@tm-hub/showcase-ui/showcase.css';
import type { Showcase } from '@tm-hub/shared/showcase';
import { go, useHubState } from '../state';
import { openRelated } from '../data/links';
import type { RelatedLink } from '../data/links';
import { useT } from '../i18n';
import { CachedImg } from './common';
import { Lightbox } from '../pages/Gallery';

const KEYS: (keyof ShowcaseLabels)[] = ['compat', 'hotkeys', 'changelog', 'faq', 'game', 'status', 'keyHeader', 'action', 'works', 'partial', 'planned', 'no', 'before', 'after', 'compareHint', 'playVideo', 'videoNote', 'openVideo', 'install', 'version'];

export function ModShowcase({ showcase, releases = [], companion, onInstall }: { showcase: Showcase; releases?: ShowcaseRelease[]; companion?: RelatedLink | null; onInstall?: () => void }) {
  const t = useT();
  const hub = useHubState();
  const [zoom, setZoom] = useState<{ list: string[]; i: number } | null>(null);
  const ctx = useMemo<ShowcaseCtx>(() => ({
    labels: Object.fromEntries(KEYS.map((k) => [k, t('showcase.' + k, { provider: '{provider}' })])) as unknown as ShowcaseLabels,
    Img: ({ url, alt, className }) => <CachedImg url={url} alt={alt} className={className} />,
    gameName: (id) => {
      const map: Record<string, string> = { eswc: 'tmn-eswc', tmo: 'tm-original', tms: 'tm-sunrise', turbo: 'tm-turbo' };
      return hub.games.find((g) => g.id === id || g.id === map[id])?.name ?? id;
    },
    releases,
    onLink: (url) => openRelated(hub, go, { kind: 'website', label: '', url }, hub.selectedGame),
    onInstall,
    companion: companion ? { label: companion.label, url: companion.url } : null,
    onZoom: (list, i) => setZoom({ list, i }),
  }), [t, hub, releases, onInstall, companion]);
  return (
    <>
      <ShowcaseView showcase={showcase} ctx={ctx} />
      {zoom && <Lightbox list={zoom.list} index={zoom.i} setIndex={(i) => setZoom(i === null ? null : { list: zoom.list, i })} />}
    </>
  );
}

/** Click on the page's own install button (the same install flow as the head of the page). */
export const clickInstall = () => { document.querySelector<HTMLButtonElement>('.detail-actions .btn.primary')?.click(); };
