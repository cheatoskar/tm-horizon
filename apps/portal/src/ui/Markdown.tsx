import { ReadmeView } from '@tm-hub/showcase-ui';
import '@tm-hub/showcase-ui/readme.css';

/** Markdown (project descriptions, changelogs, legal texts) through the shared README renderer: only allowlisted
 *  tags, https pictures, links in a new tab. `title` (the project name) removes a README's first H1 that repeats it;
 *  `demote` moves headings down (descriptions sit under the page's own H1). */
export function Markdown({ text, className = '', title, demote = 0 }: { text: string; className?: string; title?: string; demote?: number }) {
  return <ReadmeView source={text} className={`md ${className}`.trim()} title={title} demote={demote} newTab />;
}

/** Editor with a live preview next to it (stacked on phones). */
export function MarkdownEditor({ value, onChange, rows = 12, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <div className="split">
      <textarea className="mono" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label="Markdown" />
      <div className="mdbox" aria-label="Preview">
        {value.trim() ? <Markdown text={value} /> : <span className="muted">Preview</span>}
      </div>
    </div>
  );
}
