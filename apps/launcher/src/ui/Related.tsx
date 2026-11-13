// "Dazu / Links" on a mod page (companion link first, as a big button) and the "Open <label>"
// buttons inside the game page's Mods section (only for installed mods with a real companion page,
// e.g. the Bingo board; docs and wikis stay on the mod's own page). The link data comes from data/links.ts.
import { BookOpen, Code2, ExternalLink, Globe, MessageCircle, Puzzle } from 'lucide-react';
import { useT } from '../i18n';
import { go, useHubState } from '../state';
import { openRelated, type RelatedLink } from '../data/links';
import { SectionHead } from './common';

const KIND_ICON = { companion: Puzzle, docs: BookOpen, discord: MessageCircle, source: Code2, website: Globe } as const;

/** Catalog labels are English; the common ones are shown in the UI language. */
const LABEL_KEY: Record<string, string> = { 'AngelScript docs': 'related.label.angelscript', 'Release notes': 'related.label.releaseNotes', 'Settings guide': 'related.label.settingsGuide', Source: 'related.label.source', Settings: 'related.label.settings' };
export const linkLabel = (t: (k: string) => string, l: RelatedLink) => (LABEL_KEY[l.label] ? t(LABEL_KEY[l.label]) : l.label);

export function RelatedSection({ links }: { links: RelatedLink[] }) {
  const t = useT();
  const hub = useHubState();
  if (!links.length) return null;
  const open = (l: RelatedLink) => openRelated(hub, go, l, hub.selectedGame);
  const main = links.find((l) => l.kind === 'companion');
  const rest = links.filter((l) => l !== main);
  return (
    <section className="panel related" data-testid="related">
      <SectionHead title={t('related.title')} />
      <div className="related-row">
        {main && (
          <button className="btn primary related-main" onClick={() => open(main)} title={main.url}>
            <Puzzle size={20} />
            <span className="grow"><b>{linkLabel(t, main)}</b><span className="dim small">{t('related.kind.companion')}</span></span>
            <ExternalLink size={15} />
          </button>
        )}
        {rest.map((l) => {
          const Icon = KIND_ICON[l.kind];
          return <button key={l.url} className="btn ghost" onClick={() => open(l)} title={l.url}><Icon size={15} /> {linkLabel(t, l)} <span className="dim small">{t('related.kind.' + l.kind)}</span></button>;
        })}
      </div>
    </section>
  );
}

/** Game page, inside the Mods section: one button per installed mod that has a companion page. */
export function CompanionButtons({ items, game }: { items: { mod: string; link: RelatedLink }[]; game: string }) {
  const t = useT();
  const hub = useHubState();
  if (!items.length) return null;
  return (
    <div className="companion-row" data-testid="companions">
      <span className="dim small">{t('related.title')}:</span>
      {items.map(({ mod, link }) => (
        <button key={mod + link.url} className="btn ghost sm companion-btn" title={`${mod}: ${link.url}`} onClick={() => openRelated(hub, go, link, game)}>
          <Puzzle size={14} /> {t('related.open', { label: linkLabel(t, link) })}
        </button>
      ))}
    </div>
  );
}
