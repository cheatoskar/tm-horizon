import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import '@tm-hub/shared/tokens.css';
import './styles.css';
import './styles-live.css';
import './styles-browser.css';
import './styles-gallery.css';
import './styles-settings.css';
import './styles-news.css';
import './styles-news2.css';
import './styles-moddetail.css';
import './styles-art.css';
import './styles-sites.css';
import './styles-r7.css';
import './styles-modsall.css';
import './styles-horizon.css';
import './styles-layout.css';
import './styles-serverquery.css';
import './styles-fix2.css';
import './styles-hosting.css';
import './styles-rc4.css';
import './styles-perf.css';
import './styles-controls.css'; // one control height per toolbar, last
import { backend } from './data/backend';
import { HubProvider } from './state';
import { I18nProvider, initLang, tr } from './i18n';
import { App } from './App';
import { StartupUpdate } from './ui/Updater';
import { bootHubIndex } from './data/hubIndex';
import './data/navHistory'; // route history for the Back buttons, from the first navigation on

const root = createRoot(document.getElementById('root')!);

/** The start screen in index.html: fades out once the app (or the error page) has painted. */
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('out');
  setTimeout(() => s.remove(), 260);
}

// Native: web links open in the user's browser, not inside the launcher.
if (backend.kind === 'native') {
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && /^https?:/i.test(a.href)) { e.preventDefault(); backend.openExternal(a.href); }
  }, true);
}

// The native backend scans this PC (read only) before the first render.
(backend.init ? backend.init() : Promise.resolve())
  .then(() => bootHubIndex()) // cached hub index only; the refresh runs in the background
  .then(() => {
    root.render(
      <I18nProvider>
        <HubProvider>
          <App />
          <StartupUpdate />
        </HubProvider>
      </I18nProvider>,
    );
    // Start-up to first paint (from page load), logged to timings.log.
    requestAnimationFrame(() => requestAnimationFrame(() => { backend.perfLog?.('first-paint', performance.now()); hideSplash(); }));
  })
  .catch((e) => {
    initLang();
    root.render(<div className="boot-error"><b>{tr('boot.failed')}</b><pre>{String(e)}</pre></div>);
    hideSplash();
  });
