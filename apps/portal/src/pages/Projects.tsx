import { Link } from 'react-router-dom';
import { Plus, Download, FolderPlus } from 'lucide-react';
import type { HubProject, HubVersion } from '@tm-hub/shared';
import { api } from '../api.ts';
import { Async, Badge, PageHead, Pic, useAsync } from '../ui/common.tsx';
import { EmptyState } from '../ui/controls.tsx';
import { gameName } from '../labels.ts';

interface Row { p: HubProject; versions: HubVersion[] }

async function load(): Promise<Row[]> {
  const ps = await api.myProjects();
  return Promise.all(ps.map(async (p) => ({ p, versions: await api.versions(p.slug).catch(() => [] as HubVersion[]) })));
}

const STATE_TONE: Record<string, string> = { listed: 'ok', review: 'warn', draft: '', removed: 'bad' };

function ProjectCard({ p, versions }: Row) {
  const held = versions.filter((v) => v.status === 'held').length;
  const review = versions.filter((v) => v.status === 'review').length;
  const choice = p.sources.filter((s) => s.needsChoice).length;
  const setup = p.sources.some((s) => s.setupNeeded);
  const errors = p.sources.filter((s) => s.lastError && !s.setupNeeded).length;
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Pic src={p.icon?.url} name={p.name} />
        <div className="grow">
          <Link to={`/projects/${p.slug}`} style={{ fontWeight: 600, fontSize: 16 }}>{p.name}</Link>
          <div className="muted small wrapword">{p.slug}</div>
        </div>
        <Badge tone={STATE_TONE[p.state]}>{p.state}</Badge>
      </div>
      <div className="muted small">{p.summary}</div>
      <div className="row small">
        <span>Latest: <b>{p.latest ?? 'none'}</b></span>
        <span className="nowrap"><Download size={13} style={{ verticalAlign: -2 }} /> {p.downloads}</span>
        <span className="muted">{p.games.slice(0, 2).map(gameName).join(', ')}{p.games.length > 2 ? ` +${p.games.length - 2}` : ''}</span>
      </div>
      <div className="row">
        {!p.claimed && <Badge tone="warn">Unclaimed</Badge>}
        {held > 0 && <Badge tone="warn">{held} held</Badge>}
        {review > 0 && <Badge tone="warn">{review} in review</Badge>}
        {choice > 0 && <Badge tone="accent">{choice} needs a choice</Badge>}
        {setup && <Link to={`/projects/${p.slug}?tab=import`} title="Choose the games and how it installs, then releases come in."><Badge tone="accent">Setup needed</Badge></Link>}
        {errors > 0 && <Badge tone="bad">{errors} source error</Badge>}
        {!held && !review && !choice && !errors && !setup && p.claimed && <span className="muted small">Nothing pending</span>}
      </div>
      <div className="row" style={{ marginTop: 'auto', paddingTop: 'var(--tm-s-2)' }}>
        <Link className="btn sm primary" to={`/projects/${p.slug}`}>Edit</Link>
        <Link className="btn sm" to={`/p/${p.slug}`}>View</Link>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const r = useAsync(load, []);
  return (
    <div className="page">
      <PageHead title="My projects">
        <span className="right row">
          <Link className="btn primary" to="/new"><Plus size={16} /> New project</Link>
          <Link className="btn" to="/new?mode=import">Import</Link>
        </span>
      </PageHead>
      <Async r={r}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState icon={<FolderPlus size={22} />} title="No projects yet" text="Paste the link to your repo and the hub fills in the details." action={<Link className="btn primary" to="/new">Add project</Link>} />
          ) : (
            <div className="cardgrid">{rows.map((x) => <ProjectCard key={x.p.id} {...x} />)}</div>
          )
        }
      </Async>
    </div>
  );
}
