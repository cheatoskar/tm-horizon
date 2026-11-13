import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { HubProject, ProjectInput } from '@tm-hub/shared';
import { api } from '../api.ts';
import { Async, Badge, Notice, PageHead, Pic, Tabs, useAsync } from '../ui/common.tsx';
import { ProjectForm } from '../ui/ProjectForm.tsx';
import { Downloads, TypeIcon, typeLabel } from '../ui/ProjectType.tsx';
import { StatementView } from '../ui/ReportView.tsx';
import { ImagesTab } from './project/Images.tsx';
import { ShowcaseTab } from './project/Showcase.tsx';
import { VersionsTab } from './project/Versions.tsx';
import { SourcesTab } from './project/Sources.tsx';
import { TeamTab } from './project/Team.tsx';
import { AnalyticsTab } from './project/Analytics.tsx';
import { ClaimTab } from './project/Claim.tsx';
import { ImportGithubTab, githubRepoOf } from './project/ImportGithub.tsx';

type Tab = 'import' | 'details' | 'images' | 'showcase' | 'versions' | 'sources' | 'team' | 'analytics' | 'claim';

const toInput = (p: HubProject): ProjectInput => ({
  name: p.name, slug: p.slug, type: p.type, summary: p.summary, description: p.description, categories: p.categories, tags: p.tags, games: p.games, installs: p.installs,
  license: p.license, links: p.links, dependencies: p.dependencies, conflicts: p.conflicts, tmloaderProduct: p.tmloaderProduct ?? null,
});

function Editor({ p, reload }: { p: HubProject; reload: () => void }) {
  const [sp, setSp] = useSearchParams();
  const member = !!p.myRole;
  const canEdit = p.myRole === 'owner' || p.myRole === 'maintainer';
  const tabs: { id: Tab; label: string }[] = [];
  if (!p.claimed) tabs.push({ id: 'claim', label: 'Claim' });
  if (member) tabs.push({ id: 'details', label: 'Details' }, { id: 'images', label: 'Images' }, { id: 'showcase', label: 'Showcase' }, { id: 'versions', label: 'Versions' }, { id: 'sources', label: 'Sources' }, { id: 'team', label: 'Team' }, { id: 'analytics', label: 'Analytics' });
  // Visitors (an unclaimed catalog project) see the showcase read-only, so they know it is there.
  else tabs.push({ id: 'showcase', label: 'Showcase' });
  // "Import from GitHub" (owners and maintainers, project with a GitHub repository) is a button in the header, not a tab.
  const canImport = canEdit && !!githubRepoOf(p);
  const wanted = sp.get('tab') as Tab | null;
  const tab: Tab = wanted === 'import' && canImport ? 'import' : tabs.some((t) => t.id === wanted) ? wanted! : tabs[0]?.id ?? 'details';
  const claimedNow = sp.get('claimed') === '1';
  const bare = !p.icon || (p.gallery.length === 0 && !p.banner);
  const pending = p.sources.filter((s) => s.needsChoice).length;
  // Pictures the import could not take (too small for a banner, not a picture): said once after the import.
  const pictureErrors = ((useLocation().state as { pictureErrors?: string[] } | null)?.pictureErrors ?? []);

  return (
    <>
      <PageHead title={<span className="row" style={{ gap: 'var(--tm-s-3)' }}><Pic src={p.icon?.url} name={p.name} /> {p.name}</span>}>
        <Badge tone={p.state === 'listed' ? 'ok' : p.state === 'removed' ? 'bad' : 'warn'}>{p.state}</Badge>
        {!p.claimed && <Badge tone="warn">Unclaimed</Badge>}
        {pending > 0 && <Badge tone="accent">Source needs a choice</Badge>}
        {canImport && <Link className="btn sm" to={`/projects/${p.slug}?tab=import`}>Import from GitHub</Link>}
        <Link className="btn sm right" to={`/p/${p.slug}`}>View page</Link>
      </PageHead>
      <div className="row projmeta">
        <span className="row typechip" title="Project type">{p.type ? <TypeIcon type={p.type} /> : null}{typeLabel(p.type)}{!p.type && canEdit && <Link to={`/projects/${p.slug}?tab=details`} className="small">Choose</Link>}</span>
        <Downloads d={p.downloadStats} />
      </div>
      {claimedNow && canImport && bare && <Notice tone="info">This project has no icon or pictures yet. <Link to={`/projects/${p.slug}?tab=import`}>Import from GitHub</Link> takes them from the repository.</Notice>}
      {pictureErrors.length > 0 && <Notice tone="warn">Some pictures were not imported: {pictureErrors.join('; ')}. Add them under Images.</Notice>}
      {p.state === 'removed' && p.removal && <StatementView s={p.removal} title="This project was taken down" />}
      {!member && p.claimed && <div className="msg">You are not a member of this project. <Link to={`/p/${p.slug}`}>View the public page</Link></div>}
      {tabs.length > 0 && <Tabs tabs={tabs} value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} />}
      {tab === 'import' && <ImportGithubTab key={p.slug} p={p} />}
      {tab === 'details' && (canEdit
        ? <ProjectForm key={p.slug} initial={toInput(p)} mode="edit" submitLabel="Save" onSubmit={async (i) => { const { slug: _s, ...rest } = i; await api.patchProject(p.slug, rest); reload(); }} />
        : <div className="msg">Only owners and maintainers can edit the details.</div>)}
      {tab === 'images' && (canEdit ? <ImagesTab p={p} reload={reload} /> : <div className="msg">Only owners and maintainers can change pictures.</div>)}
      {tab === 'showcase' && <ShowcaseTab key={p.slug} p={p} reload={reload} readOnly={!canEdit} />}
      {tab === 'versions' && <VersionsTab p={p} reloadProject={reload} />}
      {tab === 'sources' && <SourcesTab p={p} reload={reload} />}
      {tab === 'team' && <TeamTab p={p} reload={reload} />}
      {tab === 'analytics' && <AnalyticsTab p={p} />}
      {tab === 'claim' && <ClaimTab p={p} reload={reload} />}
    </>
  );
}

export function ProjectEditorPage() {
  const { slug = '' } = useParams();
  const r = useAsync(() => api.project(slug), [slug]);
  return (
    <div className="page">
      <Async r={r}>{(p) => <Editor p={p} reload={r.reload} />}</Async>
    </div>
  );
}
