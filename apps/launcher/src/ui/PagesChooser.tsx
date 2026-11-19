// Which pages the sidebar shows: three one-click presets and a checkbox per optional page. Used by the
// setup wizard (look step) and Settings > Pages; both apply at once (state.tsx setHiddenPages).
import { useT } from '../i18n';
import { useHubState } from '../state';
import { FIXED_PAGES, OPTIONAL_PAGES, PAGE_PRESETS, presetHidden, presetOf, toggleHidden } from '../data/navPages';
import { NAV } from './shell';

export function PagesChooser() {
  const { hiddenPages, setHiddenPages } = useHubState();
  const t = useT();
  const current = presetOf(hiddenPages);
  const nav = (page: string) => NAV.find((n) => n.page === page);
  const name = (page: string) => t(nav(page)?.label ?? 'nav.' + page);
  const box = (page: string, fixed: boolean) => {
    const Icon = nav(page)?.icon;
    return (
      <label key={page} className={'page-pick' + (fixed ? ' fixed' : '')} title={fixed ? t('pages.always') : undefined}>
        <input type="checkbox" checked={fixed || !hiddenPages.includes(page)} disabled={fixed} onChange={() => setHiddenPages(toggleHidden(hiddenPages, page))} />
        {Icon && <Icon size={15} aria-hidden />}
        <span>{name(page)}</span>
      </label>
    );
  };
  return (
    <div className="pages-chooser">
      <div className="presets" role="radiogroup" aria-label={t('pages.title')}>
        {PAGE_PRESETS.map((p) => {
          const shown = [...FIXED_PAGES, ...p.shown].map(name).join(', ');
          return (
            <button key={p.id} role="radio" aria-checked={current === p.id} className={'preset' + (current === p.id ? ' on' : '')}
              title={p.id === 'all' ? t('pages.allTip') : shown} onClick={() => setHiddenPages(presetHidden(p.id))}>
              {t('pages.preset.' + p.id)}
            </button>
          );
        })}
      </div>
      <div className="page-picks">
        {FIXED_PAGES.map((p) => box(p, true))}
        {OPTIONAL_PAGES.map((p) => box(p, false))}
      </div>
    </div>
  );
}
