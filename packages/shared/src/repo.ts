// The one place that knows the GitHub repository of the project (issue forms, README links).
// `public` stays false until the repository is public: github.com/<owner>/<name> answers 404 before
// that, so the launcher shows a dialog with the prepared text instead and the website disables the links.
export const REPO = { owner: 'cheatoskar', name: 'tm-horizon', public: false } as const;

export const repoUrl = (path = ''): string => `https://github.com/${REPO.owner}/${REPO.name}${path}`;

export type IssueKind = 'server' | 'event';

interface TemplateField { id: string; label: string }
interface Template { file: string; titlePrefix: string; fields: TemplateField[]; confirm?: string }

/** Mirrors .github/ISSUE_TEMPLATE/{server,event}.yml (field ids and labels). */
export const ISSUE_TEMPLATES: Record<IssueKind, Template> = {
  server: {
    file: 'server.yml',
    titlePrefix: 'Server: ',
    fields: [
      { id: 'game', label: 'Game' }, { id: 'name', label: 'Server name' }, { id: 'address', label: 'Address' },
      { id: 'login', label: 'Server login' }, { id: 'mode', label: 'Mode' }, { id: 'language', label: 'Language' },
      { id: 'description', label: 'Description' }, { id: 'contact', label: 'Discord (optional)' }, { id: 'homepage', label: 'Website (optional)' },
    ],
    confirm: 'I run this server or speak for the people who run it, and it is fine to check its game port every hour.',
  },
  event: {
    file: 'event.yml',
    titlePrefix: 'Event: ',
    fields: [
      { id: 'name', label: 'Event name' }, { id: 'games', label: 'Game' }, { id: 'date', label: 'Date' }, { id: 'time', label: 'Start time' },
      { id: 'timezone', label: 'Time zone' }, { id: 'duration', label: 'Duration' }, { id: 'host', label: 'Host community' },
      { id: 'host_link', label: 'Community link (optional)' }, { id: 'join', label: 'Server or join link (optional)' },
      { id: 'description', label: 'Description' }, { id: 'link', label: 'Link (optional)' },
    ],
  },
};

export type IssueFields = Record<string, string | null | undefined>;

/** URL of the issue form with fields filled in (only works once REPO.public is true). */
export function issueFormUrl(kind: IssueKind, fields: IssueFields = {}): string {
  const tpl = ISSUE_TEMPLATES[kind];
  const q = new URLSearchParams({ template: tpl.file });
  const title = fields.title ?? (fields.name ? tpl.titlePrefix + fields.name : null);
  if (title) q.set('title', title);
  for (const f of tpl.fields) if (fields[f.id]) q.set(f.id, fields[f.id]!);
  return repoUrl(`/issues/new?${q.toString()}`);
}

/** Title and body the issue form would produce, to copy while the repository is not public. */
export function issueDraft(kind: IssueKind, fields: IssueFields = {}): { title: string; body: string } {
  const tpl = ISSUE_TEMPLATES[kind];
  const title = fields.title ?? tpl.titlePrefix + (fields.name ?? '');
  const parts = tpl.fields.map((f) => `### ${f.label}\n\n${fields[f.id] || '_No response_'}`);
  if (tpl.confirm) parts.push(`### Confirm\n\n- [x] ${tpl.confirm}`);
  return { title, body: parts.join('\n\n') };
}
