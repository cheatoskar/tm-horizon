import { useEffect, useState } from 'react';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { backend, type RepoRelease } from '../data/backend';
import type { ModView } from '../data/model';
import { fmtSize, timeAgo } from '../data/model';
import { Markdown } from '../ui/Markdown';
import { useCachedImage } from '../ui/common';
import { loadGallery, repoUrlOf } from './Gallery';
import { useT } from '../i18n';

export { repoUrlOf };

const readmeMemo = new Map<string, Promise<string | null>>();
const releasesMemo = new Map<string, Promise<RepoRelease[]>>();

/** README of the mod's GitHub repository: undefined while loading, null when there is none. */
export function useReadme(repo: string | undefined): string | null | undefined {
  const [text, setText] = useState<string | null | undefined>(repo && backend.readme ? undefined : null);
  useEffect(() => {
    if (!repo || !backend.readme) { setText(null); return; }
    let live = true;
    setText(undefined);
    if (!readmeMemo.has(repo)) readmeMemo.set(repo, backend.readme(repo).then((s) => s.trim() || null).catch(() => null));
    readmeMemo.get(repo)!.then((s) => { if (live) setText(s); });
    return () => { live = false; };
  }, [repo]);
  return text;
}

/** GitHub releases of the mod's repository; empty when there are none or the call fails. */
export function useReleases(repo: string | undefined): RepoRelease[] | undefined {
  const [list, setList] = useState<RepoRelease[] | undefined>(repo && backend.releases ? undefined : []);
  useEffect(() => {
    if (!repo || !backend.releases) { setList([]); return; }
    let live = true;
    setList(undefined);
    if (!releasesMemo.has(repo)) releasesMemo.set(repo, backend.releases(repo).catch(() => []));
    releasesMemo.get(repo)!.then((l) => { if (live) setList(l); });
    return () => { live = false; };
  }, [repo]);
  return list;
}

/** Release whose tag matches a TMLoader version ("v1.2" matches "1.2"). */
export function releaseFor(list: RepoRelease[] | undefined, version: string): RepoRelease | undefined {
  const norm = (s: string) => s.trim().replace(/^v/i, '');
  return list?.find((r) => norm(r.tag) === norm(version));
}

/** Blurred, darkened first repository picture behind the head of the mod page. */
export function HeroBg({ mod }: { mod: ModView }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    loadGallery(mod).then((l) => { if (live) setUrl(l[0] ?? null); });
    return () => { live = false; };
  }, [mod.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const src = useCachedImage(url);
  if (!src) return null;
  return (
    <div className="md-hero-bg" aria-hidden="true">
      <div className="md-hero-img" style={{ backgroundImage: `url("${src.replace(/"/g, '%22')}")` }} />
    </div>
  );
}

export function Loading() {
  const t = useT();
  return <p className="dim"><Loader2 size={14} className="spin" /> {t('moddetail.loading')}</p>;
}

/** Description tab for a GitHub-hosted mod: the README. Falls back to the plain description. */
export function ReadmeView({ repo, fallback, title }: { repo: string; fallback: string; title?: string }) {
  const t = useT();
  const text = useReadme(repo);
  return (
    <section className="panel md-panel">
      {text === undefined && <Loading />}
      {text === null && <><p className="lead">{fallback}</p><p className="dim small">{t('moddetail.noReadme')}</p></>}
      {text && <Markdown text={text} title={title} />}
      <a className="btn ghost sm md-gh" href={repo} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t('moddetail.openRepo')}</a>
    </section>
  );
}

/** Notes of one release (used in the changelog tab when TMLoader has none). */
export function ReleaseNotes({ release }: { release: RepoRelease }) {
  const t = useT();
  return release.notes.trim() ? <Markdown text={release.notes} className="md-notes" /> : <p className="dim">{t('moddetail.noNotes')}</p>;
}

/** GitHub releases with files and notes. */
export function ReleasesList({ list }: { list: RepoRelease[] | undefined }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (list === undefined) return <Loading />;
  if (list.length === 0) return <p className="dim">{t('moddetail.noReleases')}</p>;
  return (
    <ul className="md-releases">
      {list.map((r, i) => {
        const on = open === r.tag || (open === null && i === 0);
        return (
          <li key={r.tag} className={on ? 'on' : ''}>
            <button className="md-rel-head" onClick={() => setOpen(on ? '' : r.tag)} aria-expanded={on}>
              <span className="ver-badge">{r.tag}</span>
              {r.name !== r.tag && <b className="ellip">{r.name}</b>}
              {r.prerelease && <span className="pill tiny">{t('moddetail.prerelease')}</span>}
              <span className="grow" />
              <span className="dim small">{r.date ? timeAgo(r.date) : ''}</span>
            </button>
            {on && (
              <div className="md-rel-body">
                {r.assets.length > 0 && (
                  <div className="md-assets">
                    {r.assets.map((a) => (
                      <a key={a.name} className="md-asset" href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                        <Download size={13} /> <span className="ellip">{a.name}</span> <span className="dim small">{fmtSize(a.size)}</span>
                      </a>
                    ))}
                  </div>
                )}
                <ReleaseNotes release={r} />
                <a className="linkish small" href={r.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t('moddetail.onGithub')}</a>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
