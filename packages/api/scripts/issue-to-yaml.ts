// Approved issue (server.yml or event.yml form) -> data/servers/<id>.yaml or data/events/<id>.yaml.
// Run by .github/workflows/registry.yml when a maintainer adds the label "approved":
//   node scripts/issue-to-yaml.ts "$GITHUB_EVENT_PATH"
// Locally: node scripts/issue-to-yaml.ts event.json   (a saved issues event payload)
// The issue body is untrusted text: it is only parsed and validated here, never passed to a shell.
// Writes to $GITHUB_OUTPUT: kind, id, file, title. On invalid input writes registry-errors.md, exit 1.
import fs from 'node:fs';
import path from 'node:path';
import { entryToYaml } from '../src/lib/registry.ts';
import { eventFromForm, parseIssueForm, serverFromForm } from '../src/lib/issue-form.ts';

const root = path.resolve(import.meta.dirname, '..');
const eventFile = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
if (!eventFile) {
  console.error('usage: node scripts/issue-to-yaml.ts <event.json>');
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(eventFile, 'utf8')) as {
  issue: { number: number; body: string | null; labels: { name: string }[] };
};
const issue = payload.issue;
const labels = issue.labels.map((l) => l.name);
const kind = labels.includes('server') ? 'server' : labels.includes('event') ? 'event' : null;
const fail = (lines: string[]) => {
  const text = `The entry could not be converted:\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nPlease edit the issue; a maintainer then removes and re-adds the label \`approved\`.\n`;
  fs.writeFileSync(path.join(root, 'registry-errors.md'), text);
  console.error(text);
  process.exit(1);
};
if (!kind) fail(['the issue has neither the label "server" nor "event"']);

const dirName = kind === 'server' ? 'servers' : 'events';
const dir = path.join(root, 'data', dirName);
fs.mkdirSync(dir, { recursive: true });
const template = fs.readFileSync(path.join(root, '..', '..', '.github', 'ISSUE_TEMPLATE', `${kind}.yml`), 'utf8');
const fields = parseIssueForm(issue.body ?? '', template);
// ids already used by other issues; an entry from this same issue is replaced
const taken = new Set<string>();
let existing: string | null = null;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (new RegExp(`^issue: ${issue.number}$`, 'm').test(text)) existing = f;
  else taken.add(f.replace(/\.yaml$/, ''));
}
const today = new Date().toISOString().slice(0, 10);
const checked = kind === 'server' ? serverFromForm(fields, issue.number, taken, today) : eventFromForm(fields, issue.number, taken);
if (!checked.entry) fail(checked.errors);
const entry = checked.entry!;
if (existing && existing !== `${entry.id}.yaml`) fs.rmSync(path.join(dir, existing));
const file = `data/${dirName}/${entry.id}.yaml`;
fs.writeFileSync(path.join(root, file), entryToYaml(entry, `from issue #${issue.number} (approved)`));
const title = `${kind === 'server' ? 'Server' : 'Event'}: ${'name' in entry ? entry.name : entry.title}`.replace(/[\r\n]/g, ' ').slice(0, 120);
console.log(`wrote ${file}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\nid=${entry.id}\nfile=${file}\ntitle=${title}\n`);
}
