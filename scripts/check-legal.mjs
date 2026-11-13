// Lists the open placeholders ([ ... ]) in the legal texts that the website and the portal show:
// docs/hub/legal/{impressum,datenschutz,nutzungsbedingungen}.md (German, binding) and docs/hub/legal/en/ (English).
// What goes into each placeholder: docs/hub/legal/AUSFUELLEN.md.
//
//   npm run check-legal              list per file (exit code 0, the dev build never fails on this)
//   npm run check-legal -- --summary one line (used by the website build)
//   npm run check-legal -- --strict  exit code 1 while anything is open (for the going-live check)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['impressum', 'datenschutz', 'nutzungsbedingungen'];
const files = [...DOCS.map((d) => join(root, 'docs/hub/legal', `${d}.md`)), ...DOCS.map((d) => join(root, 'docs/hub/legal/en', `${d}.md`))].filter((f) => existsSync(f));

/** Placeholders of one Markdown text: [ ... ] that is not a link, not a checkbox, not inside `code`. */
export function placeholders(text) {
  const out = [];
  text.replace(/\r/g, '').split('\n').forEach((line, i) => {
    const plain = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const m of plain.matchAll(/\[([^\]]+)\](?![(:])/g)) {
      if (/^\s?[xX ]?\s?$/.test(m[1])) continue; // [ ] / [x] checkboxes
      out.push({ line: i + 1, text: m[0] });
    }
  });
  return out;
}

const args = process.argv.slice(2);
let total = 0;
const report = [];
for (const f of files) {
  const found = placeholders(readFileSync(f, 'utf8'));
  total += found.length;
  if (!found.length) continue;
  const byText = new Map();
  for (const p of found) byText.set(p.text, [...(byText.get(p.text) ?? []), p.line]);
  report.push(`\n${relative(root, f).replace(/\\/g, '/')}: ${found.length} open`);
  for (const [text, lines] of byText) report.push(`  ${text}  (line ${lines.join(', ')})`);
}

if (args.includes('--summary')) {
  console.log(total ? `check-legal: ${total} open placeholder(s) in the legal texts (npm run check-legal lists them; docs/hub/legal/AUSFUELLEN.md says what goes there)` : 'check-legal: no open placeholders');
} else {
  console.log(report.join('\n') || 'No open placeholders.');
  console.log(`\ncheck-legal: ${total} open placeholder(s) in ${files.length} files. What goes where: docs/hub/legal/AUSFUELLEN.md`);
}
if (args.includes('--strict') && total) process.exit(1);
