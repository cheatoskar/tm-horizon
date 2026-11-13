import { useState } from 'react';
import type { HubProject, ProjectRole } from '@tm-hub/shared';
import { api } from '../../api.ts';
import { useAuth } from '../../auth.tsx';
import { Badge, Field, Notice, Pic, useAction } from '../../ui/common.tsx';
import { Section } from '../../ui/controls.tsx';

const ROLE_HELP: Record<ProjectRole, string> = {
  owner: 'Owner: everything, including the team.',
  maintainer: 'Maintainer: edit details, pictures, sources and versions.',
  uploader: 'Uploader: upload versions only.',
};

export function TeamTab({ p, reload }: { p: HubProject; reload: () => void }) {
  const { user } = useAuth();
  const isOwner = p.myRole === 'owner';
  const [who, setWho] = useState('');
  const [role, setRole] = useState<ProjectRole>('maintainer');
  const { busy, error, run } = useAction();
  return (
    <>
      {error && <Notice tone="err">{error}</Notice>}
      <Section title="Team" help="Everyone who can work on this project.">
        {p.team.map((m) => (
          <div className="list-row" key={m.user.id}>
            <Pic src={m.user.avatar} name={m.user.name} />
            <div className="grow"><b>{m.user.name}</b> <span className="muted small mono">{m.user.id}</span></div>
            <Badge tone={m.role === 'owner' ? 'accent' : ''} title={ROLE_HELP[m.role]}>{m.role}</Badge>
            {(isOwner || m.user.id === user?.id) && m.role !== 'owner' && (
              <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm(m.user.id === user?.id ? 'Leave this project?' : `Remove ${m.user.name}?`)) void run(async () => { await api.removeMember(p.slug, m.user.id); reload(); }); }}>
                {m.user.id === user?.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </div>
        ))}
      </Section>
      {isOwner ? (
        <Section title="Add member">
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.setMember(p.slug, who.trim(), role); setWho(''); reload(); }); }}>
          <div className="cols2">
            <Field label="Account" hint="Like github:name or discord:name, or a hub user id. They must have logged in once.">
              <input required placeholder="github:username" value={who} onChange={(e) => setWho(e.target.value)} />
            </Field>
            <Field label="Role" hint={ROLE_HELP[role]}>
              <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
                <option value="uploader">Uploader</option><option value="maintainer">Maintainer</option>
                <option value="owner">Owner (hands the project over)</option>
              </select>
            </Field>
          </div>
          {role === 'owner' && <Notice tone="warn">You become a maintainer. Updates get a human look for 14 days after a hand-over.</Notice>}
          <button className="btn primary" disabled={busy || who.trim().length < 3}>{busy ? 'Adding' : 'Add'}</button>
        </form>
        </Section>
      ) : <Notice tone="info">Only the owner can change the team.</Notice>}
    </>
  );
}
