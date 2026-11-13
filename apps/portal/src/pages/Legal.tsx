import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Markdown } from '../ui/Markdown.tsx';
import { EmptyState } from '../ui/controls.tsx';

// Same sources as the website (docs/hub/legal): German (binding) and the English translation in en/.
// Only the three published texts; AUSFUELLEN.md (fill-in notes) is not a page.
const de = import.meta.glob('../../../../docs/hub/legal/{impressum,datenschutz,nutzungsbedingungen}.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const en = import.meta.glob('../../../../docs/hub/legal/en/{impressum,datenschutz,nutzungsbedingungen}.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const byName = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, text]) => [p.split('/').pop()!.replace(/\.md$/, ''), text]));
const DE = byName(de);
const EN = byName(en);

/** `{#id}` heading anchors are for the website's renderer; marked would print them. */
const clean = (s: string) => s.replace(/^(#{1,6} .*?)\s*\{#[a-z0-9-]+\}\s*$/gm, '$1');

export function LegalPage() {
  const { name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const lang = params.get('lang') === 'en' && EN[name] ? 'en' : 'de';
  const text = lang === 'en' ? EN[name] : DE[name];
  return (
    <div className="page narrow">
      {text ? (
        <>
          <p className="muted small" style={{ marginBottom: 'var(--tm-s-4)' }}>
            {lang === 'de'
              ? EN[name] && <button className="btn sm ghost" onClick={() => setParams({ lang: 'en' })}>English version</button>
              : <>English translation; the German version is binding. <button className="btn sm ghost" onClick={() => setParams({})}>Deutsche Fassung</button></>}
          </p>
          <div className="card" style={{ padding: 'var(--tm-s-5)' }}><Markdown text={clean(text)} /></div>
        </>
      ) : <EmptyState title="Page not found" text="This legal text does not exist." action={<Link className="btn" to="/">Back to start</Link>} />}
    </div>
  );
}
