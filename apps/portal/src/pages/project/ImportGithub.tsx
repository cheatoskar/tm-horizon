import { useEffect, useState } from 'react';
import type { HubProject, SourcePreview } from '@tm-hub/shared';
import { api } from '../../api.ts';
import { Notice, useAction } from '../../ui/common.tsx';
import { Preview } from '../NewProject.tsx';

/** "owner/repo" of the project's GitHub source or source link, or null. */
export function githubRepoOf(p: HubProject): string | null {
  const s = p.sources.find((x) => x.kind === 'github');
  if (s) return s.target;
  const link = [p.links.source, p.links.homepage].find((u) => u && /github\.com\/[^/]+\/[^/#?]+/i.test(u));
  const m = link ? /github\.com\/([^/]+\/[^/#?]+)/i.exec(link) : null;
  return m ? m[1]!.replace(/\.git$/, '') : null;
}

/** "Import from GitHub": the import preview for an existing project; only the ticked items are applied. */
export function ImportGithubTab({ p }: { p: HubProject }) {
  const repo = githubRepoOf(p);
  const [url, setUrl] = useState(repo ? `https://github.com/${repo}` : '');
  const [pv, setPv] = useState<SourcePreview | null>(null);
  const { busy, error, run } = useAction();
  const look = () => run(async () => { setPv(await api.preview(url)); });
  useEffect(() => { if (repo) void look(); /* once, for the known repository */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="imp-page">
      <div className="card">
        <h2>Import from GitHub</h2>
        <p className="muted">The hub reads the repository and shows what it found. Tick what you want on this project; nothing else changes. The repository also becomes the source of new versions.</p>
        <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); setPv(null); void look(); }}>
          <input style={{ flex: 1 }} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Repository URL" />
          <button className="btn primary" disabled={busy || url.trim().length < 3}>{busy ? 'Looking' : 'Preview'}</button>
        </form>
        {error && <div style={{ marginTop: 'var(--tm-s-3)' }}><Notice tone="err">{error}</Notice></div>}
      </div>
      {pv && <Preview key={pv.target} pv={pv} url={url} existing={p} onProduct={() => {}} />}
    </div>
  );
}
