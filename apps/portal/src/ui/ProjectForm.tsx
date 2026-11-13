import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { HUB_CATEGORIES, PROJECT_TYPES, RELATED_KINDS, MAX_RELATED, type HubDependency, type ProjectInput, type RelatedLink } from '@tm-hub/shared';
import { Field, Notice, useAction } from './common.tsx';
import { Checkbox, Section } from './controls.tsx';
import { MarkdownEditor } from './Markdown.tsx';
import { GamePicker, InstallEditor } from './InstallEditor.tsx';
import { TypePicker } from './ProjectType.tsx';

export const EMPTY_INPUT: ProjectInput = {
  name: '', slug: '', type: null, summary: '', description: '', categories: [], tags: [], games: [], installs: {}, license: null,
  links: {}, dependencies: [], conflicts: [], tmloaderProduct: null,
};

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function DepEditor({ label, hint, value, onChange }: { label: string; hint: string; value: HubDependency[]; onChange: (v: HubDependency[]) => void }) {
  const set = (i: number, d: Partial<HubDependency>) => onChange(value.map((x, j) => (i === j ? { ...x, ...d } : x)));
  return (
    <Field label={label} hint={hint}>
      {value.map((d, i) => (
        <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
          <input placeholder="Project or product id" value={d.id} onChange={(e) => set(i, { id: e.target.value })} aria-label="Id" />
          <input placeholder="Version (any)" style={{ maxWidth: 140 }} value={d.version ?? ''} onChange={(e) => set(i, { version: e.target.value || null })} aria-label="Version range" />
          <span className="nowrap small" title="The id is a TMLoader product, not a hub project."><Checkbox checked={!!d.tmloader} onChange={(c) => set(i, { tmloader: c })} label="TMLoader" /></span>
          <button type="button" className="btn icon ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
        </div>
      ))}
      <div><button type="button" className="btn sm" onClick={() => onChange([...value, { id: '', version: null }])}><Plus size={14} /> Add</button></div>
    </Field>
  );
}

const KIND_LABEL: Record<RelatedLink['kind'], string> = { companion: 'Companion page', docs: 'Docs', discord: 'Discord', source: 'Source', website: 'Website' };

/** "Related links": a companion page (shown as a big button on the game page), docs, Discord, source, website. */
function RelatedEditor({ value, onChange }: { value: RelatedLink[]; onChange: (v: RelatedLink[]) => void }) {
  const set = (i: number, d: Partial<RelatedLink>) => onChange(value.map((x, j) => (i === j ? { ...x, ...d } : x)));
  return (
    <Field label="Related links" hint="Shown on the mod page in the launcher, companion first. A companion page also gets an “Open” button on the game page. https only. Browser extensions: put the store pages here.">
      {value.map((l, i) => (
        <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
          <select value={l.kind} onChange={(e) => set(i, { kind: e.target.value as RelatedLink['kind'] })} aria-label="Kind" style={{ maxWidth: 150 }}>
            {RELATED_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input placeholder="Button text, e.g. Bingo board" maxLength={40} style={{ maxWidth: 220 }} value={l.label} onChange={(e) => set(i, { label: e.target.value })} aria-label="Label" />
          <input type="url" placeholder="https://" value={l.url} onChange={(e) => set(i, { url: e.target.value })} aria-label="Link" />
          <button type="button" className="btn icon ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
        </div>
      ))}
      {value.length < MAX_RELATED && <div><button type="button" className="btn sm" onClick={() => onChange([...value, { kind: value.some((x) => x.kind === 'companion') ? 'docs' : 'companion', label: '', url: '' }])}><Plus size={14} /> Add</button></div>}
    </Field>
  );
}

/** Full project form: used for "Create by hand" and the Details tab. */
export function ProjectForm({ initial, mode, submitLabel, onSubmit }: {
  initial: ProjectInput;
  mode: 'create' | 'edit';
  submitLabel: string;
  onSubmit: (input: ProjectInput) => Promise<unknown>;
}) {
  const [v, setV] = useState<ProjectInput>(initial);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [slugTouched, setSlugTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const upd = (p: Partial<ProjectInput>) => { setSaved(false); setV((x) => ({ ...x, ...p })); };
  const link = (k: 'homepage' | 'source' | 'issues' | 'discord', val: string) => {
    const links = { ...v.links };
    if (val.trim()) links[k] = val.trim(); else delete links[k];
    upd({ links });
  };
  const clean = (d: HubDependency[]) => d.filter((x) => x.id.trim()).map((x) => ({ ...x, id: x.id.trim(), version: x.version?.trim() || null }));
  const delivery = v.type ? PROJECT_TYPES[v.type].delivery : null;
  const noInstall = delivery === 'browser' || delivery === 'link';
  const missing = !v.type ? 'Choose what the project is.' : v.games.length === 0 ? 'Pick at least one game.' : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await onSubmit({
            ...v,
            tags: tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
            dependencies: clean(v.dependencies), conflicts: clean(v.conflicts),
            links: { ...v.links, ...(v.links.related?.some((l) => l.url.trim() || l.label.trim()) ? { related: v.links.related.filter((l) => l.url.trim() || l.label.trim()).map((l) => ({ ...l, label: l.label.trim(), url: l.url.trim() })) } : { related: undefined }) },
            license: v.license?.trim() || null, tmloaderProduct: v.tmloaderProduct?.trim() || null,
            ...(noInstall ? { installs: {} } : {}),
          });
          setSaved(true);
        });
      }}
    >
      {error && <Notice tone="err">{error}</Notice>}
      <Section title="What is it?" help="Players see this type in the launcher and on the website. It also decides how the launcher installs it.">
        <TypePicker value={v.type ?? null} onChange={(t) => upd({ type: t })} />
      </Section>

      <Section title="Name and description" help="The summary is the line under the name in lists. The description is the long text on the project page.">
        <div className="cols2">
          <Field label="Name"><input required minLength={2} maxLength={64} value={v.name} onChange={(e) => { upd({ name: e.target.value, ...(mode === 'create' && !slugTouched ? { slug: slugify(e.target.value) } : {}) }); }} /></Field>
          {mode === 'create' && (
            <Field label="URL name" hint="3-48 characters: a-z, 0-9 and dashes. Cannot be changed later.">
              <input required pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={3} maxLength={48} value={v.slug} onChange={(e) => { setSlugTouched(true); upd({ slug: e.target.value }); }} />
            </Field>
          )}
        </div>
        <Field label="Summary" hint="One or two sentences, 10 to 200 characters.">
          <input required minLength={10} maxLength={200} value={v.summary} onChange={(e) => upd({ summary: e.target.value })} />
        </Field>
        <Field label="Description" hint="Markdown. Shown on the project page.">
          <MarkdownEditor value={v.description} onChange={(d) => upd({ description: d })} />
        </Field>
      </Section>

      <Section title="Games and install" help={noInstall ? 'Not installed into a game. The games only say which game it is for.' : 'Pick the games it works with, then how each game gets the files. New versions use these settings.'}>
        {noInstall
          ? <GamePicker games={v.games} onChange={(games) => upd({ games, installs: {} })} />
          : <InstallEditor games={v.games} installs={v.installs} onChange={(games, installs) => upd({ games, installs })} />}
        {!noInstall && (
          <Field label="TMLoader product id" hint="Only for TMLoader installs. DLL-only uploads are wrapped into Product/version/.">
            <input value={v.tmloaderProduct ?? ''} onChange={(e) => upd({ tmloaderProduct: e.target.value })} />
          </Field>
        )}
      </Section>

      <Section title="Categories and tags" help="Up to 4 categories and 10 tags. They help players find the project.">
        <div className="checks" style={{ marginBottom: 'var(--tm-s-4)' }}>
          {HUB_CATEGORIES.map((c) => (
            <Checkbox key={c} label={c} checked={v.categories.includes(c)} disabled={!v.categories.includes(c) && v.categories.length >= 4}
              onChange={(on) => upd({ categories: on ? [...v.categories, c] : v.categories.filter((x) => x !== c) })} />
          ))}
        </div>
        <Field label="Tags" hint="Comma separated (a-z, 0-9, space, dash).">
          <input value={tags} onChange={(e) => { setSaved(false); setTags(e.target.value); }} />
        </Field>
      </Section>

      <Section title="Links and licence" help="Links open in the browser. Only https links are accepted.">
        <div className="cols2">
          <Field label="Licence" hint="SPDX id, e.g. MIT or GPL-3.0-only."><input maxLength={64} value={v.license ?? ''} onChange={(e) => upd({ license: e.target.value })} /></Field>
          <Field label="Homepage"><input type="url" placeholder="https://" value={v.links.homepage ?? ''} onChange={(e) => link('homepage', e.target.value)} /></Field>
          <Field label="Source code"><input type="url" placeholder="https://" value={v.links.source ?? ''} onChange={(e) => link('source', e.target.value)} /></Field>
          <Field label="Issues"><input type="url" placeholder="https://" value={v.links.issues ?? ''} onChange={(e) => link('issues', e.target.value)} /></Field>
          <Field label="Discord"><input type="url" placeholder="https://discord.gg/" value={v.links.discord ?? ''} onChange={(e) => link('discord', e.target.value)} /></Field>
        </div>
        <RelatedEditor value={v.links.related ?? []} onChange={(related) => { const links = { ...v.links }; if (related.length) links.related = related; else delete links.related; upd({ links }); }} />
      </Section>

      {!noInstall && (
        <Section title="Dependencies" help="Other mods this one needs, or cannot run next to.">
          <DepEditor label="Needs" hint="Installed together with this mod." value={v.dependencies} onChange={(d) => upd({ dependencies: d })} />
          <DepEditor label="Conflicts" hint="Cannot be installed next to this mod." value={v.conflicts} onChange={(d) => upd({ conflicts: d })} />
        </Section>
      )}

      <div className="row form-actions">
        <button className="btn primary" type="submit" disabled={busy || !!missing}>{busy ? 'Saving' : submitLabel}</button>
        {missing && <span className="hint">{missing}</span>}
        {saved && <span className="badge ok">Saved</span>}
      </div>
    </form>
  );
}
