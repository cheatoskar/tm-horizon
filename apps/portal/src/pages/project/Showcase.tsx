// Showcase editor: the block list (add, remove, reorder), the fields of each block and a live preview that
// uses the same renderer as the launcher (packages/showcase-ui). What is saved passes the hub's strict
// validator (packages/shared/src/showcase.ts); the same validator runs here on every keystroke, so a
// problem shows up next to its block before Save.
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, BookCopy, Github, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { HUB_GAMES, type HubImage, type HubProject } from '@tm-hub/shared';
import {
  ACCENTS, BLOCK_TYPES, COMPAT_STATUS, CTA_KINDS, SHOWCASE_ICONS, SHOWCASE_LIMITS as L, validateShowcase,
  type ShowcaseBlockType, type ShowcaseIssue,
} from '@tm-hub/shared/showcase';
import { ShowcaseView } from '@tm-hub/showcase-ui';
import '@tm-hub/showcase-ui/showcase.css';
import { api, ApiError } from '../../api.ts';
import { Badge, Field, Notice, useAction } from '../../ui/common.tsx';
import { EmptyState } from '../../ui/controls.tsx';
import { useScheme } from '../../ui/theme.ts';

type Blk = { type: ShowcaseBlockType; [k: string]: any };
type Doc = { version: 1; theme?: { accent: string }; blocks: Blk[] };

const TYPE_LABEL: Record<ShowcaseBlockType, string> = {
  hero: 'Hero', features: 'Feature grid', gallery: 'Gallery', compare: 'Before / after', video: 'Video', text: 'Text', compat: 'Compatibility',
  hotkeys: 'Hotkeys', changelog: 'Latest changes', faq: 'FAQ', cta: 'Buttons',
};
const HINT: Partial<Record<ShowcaseBlockType, string>> = {
  hero: 'Big header with a picture, a tagline and up to 3 badges. One per page.',
  changelog: 'Shows the notes of the newest versions. Left out while there are none.',
  cta: 'Install and companion buttons only show where they can work.',
};

const fresh = (type: ShowcaseBlockType, p: HubProject): Blk => {
  switch (type) {
    case 'hero': return { type, title: p.name, tagline: '' };
    case 'features': return { type, items: [{ icon: 'sparkles', title: '', text: '' }] };
    case 'gallery': return { type, images: [{ url: '' }] };
    case 'compare': return { type, before: { url: '' }, after: { url: '' } };
    case 'video': return { type, url: '' };
    case 'text': return { type, markdown: '' };
    case 'compat': return { type, rows: [{ game: p.games[0] ?? 'tmnf', status: 'works' }] };
    case 'hotkeys': return { type, rows: [{ keys: '', action: '' }] };
    case 'changelog': return { type, count: 1 };
    case 'faq': return { type, items: [{ q: '', a: '' }] };
    case 'cta': return { type, buttons: [{ kind: 'install', label: 'Install' }] };
  }
};

/** Empty strings and empty optional objects go, so a blank optional field is "not set". */
function prune<T>(v: T): T {
  if (Array.isArray(v)) return v.map(prune) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === '' || x === undefined || x === null) continue;
      o[k] = prune(x);
    }
    return o as T;
  }
  return v;
}

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };

// ---------------------------------------------------------------- small inputs

function Txt({ label, value, onChange, max, hint, area }: { label: string; value: string | undefined; onChange: (v: string) => void; max: number; hint?: string; area?: boolean }) {
  return (
    <Field label={label} hint={hint ?? `${(value ?? '').length} / ${max}`}>
      {area
        ? <textarea rows={6} maxLength={max * 2} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input maxLength={max * 2} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function ImgField({ label, value, onChange, p, reload }: { label: string; value: string | undefined; onChange: (v: string) => void; p: HubProject; reload: () => void }) {
  const { busy, error, run } = useAction();
  const mine: [string, HubImage][] = [...(p.banner ? [['Banner', p.banner] as [string, HubImage]] : []), ...p.gallery.map((g, i) => [`Gallery ${i + 1}`, g] as [string, HubImage])];
  return (
    <Field label={label} hint="https, .png .jpg .webp .gif. From this project's pictures, an upload, or raw.githubusercontent.com, a GitHub release or i.imgur.com.">
      <div className="row">
        <input style={{ flex: 1, minWidth: 180 }} value={value ?? ''} placeholder="https://..." onChange={(e) => onChange(e.target.value)} />
        {mine.length > 0 && (
          <select aria-label={`${label}: project picture`} value="" onChange={(e) => e.target.value && onChange(e.target.value)}>
            <option value="">Project picture...</option>
            {mine.map(([n, g]) => <option key={g.id} value={g.url}>{n}</option>)}
          </select>
        )}
        <label className="btn sm" style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading' : 'Upload'}
          <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            void run(async () => {
              const form = new FormData();
              form.append('kind', 'gallery');
              form.append('caption', 'Showcase');
              form.append('file', f, f.name);
              const img = await api.uploadImage(p.slug, form);
              onChange(img.url);
              reload();
            });
          }} />
        </label>
      </div>
      {error && <div className="msg err" role="alert">{error}</div>}
    </Field>
  );
}

function ListEditor<T>({ items, set, make, max, render, noun }: { items: T[]; set: (v: T[]) => void; make: () => T; max: number; render: (it: T, upd: (v: T) => void, i: number) => React.ReactNode; noun: string }) {
  const move = (i: number, d: number) => { const n = [...items]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; set(n); };
  return (
    <div className="stack">
      {items.map((it, i) => (
        <div key={i} className="sc-ed-item">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted small">{noun} {i + 1}</span>
            <span className="row" style={{ gap: 4 }}>
              <button type="button" className="btn icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${noun} up`}><ArrowUp size={14} /></button>
              <button type="button" className="btn icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${noun} down`}><ArrowDown size={14} /></button>
              <button type="button" className="btn icon danger" disabled={items.length <= 1} onClick={() => set(items.filter((_, j) => j !== i))} aria-label={`Remove ${noun}`}><Trash2 size={14} /></button>
            </span>
          </div>
          {render(it, (v) => set(items.map((x, j) => (j === i ? v : x))), i)}
        </div>
      ))}
      {items.length < max && <button type="button" className="btn sm" onClick={() => set([...items, make()])}><Plus size={14} /> Add {noun}</button>}
    </div>
  );
}

// ---------------------------------------------------------------- one block

function BlockFields({ b, set, p, reload }: { b: Blk; set: (b: Blk) => void; p: HubProject; reload: () => void }) {
  const u = (patch: Record<string, unknown>) => set({ ...b, ...patch });
  const title = <Txt label="Heading (optional)" value={b.title} onChange={(v) => u({ title: v })} max={L.blockTitle} />;
  switch (b.type) {
    case 'hero':
      return (
        <>
          <Txt label="Title" value={b.title} onChange={(v) => u({ title: v })} max={L.heroTitle} />
          <Txt label="Tagline" value={b.tagline} onChange={(v) => u({ tagline: v })} max={L.tagline} />
          <ImgField label="Background picture" value={b.image} onChange={(v) => u({ image: v })} p={p} reload={reload} />
          <Txt label="Video (YouTube, Vimeo or Streamable)" value={b.video} onChange={(v) => u({ video: v })} max={L.url} hint="Loads only after a click." />
          <Field label="Badges" hint={`Up to ${L.badges}, ${L.badge} characters each.`}>
            <div className="row">
              {[0, 1, 2].map((i) => (
                <input key={i} style={{ width: 150 }} maxLength={L.badge * 2} aria-label={`Badge ${i + 1}`} value={(b.badges ?? [])[i] ?? ''}
                  onChange={(e) => { const n = [...(b.badges ?? ['', '', ''])]; while (n.length < 3) n.push(''); n[i] = e.target.value; u({ badges: n.filter((x: string, j: number) => x || j < i) }); }} />
              ))}
            </div>
          </Field>
        </>
      );
    case 'features':
      return (
        <>
          {title}
          <ListEditor noun="feature" items={b.items ?? []} set={(items) => u({ items })} max={L.features} make={() => ({ icon: 'sparkles', title: '', text: '' })} render={(it, upd) => (
            <div className="row top">
              <Field label="Icon"><select value={it.icon} onChange={(e) => upd({ ...it, icon: e.target.value })}>{SHOWCASE_ICONS.map((i) => <option key={i}>{i}</option>)}</select></Field>
              <div className="grow"><Txt label="Title" value={it.title} onChange={(v) => upd({ ...it, title: v })} max={L.featureTitle} /></div>
              <div style={{ flexBasis: '100%' }}><Txt label="Text (one or two lines)" value={it.text} onChange={(v) => upd({ ...it, text: v })} max={L.featureText} /></div>
            </div>
          )} />
        </>
      );
    case 'gallery':
      return (
        <>
          {title}
          <ListEditor<any> noun="picture" items={b.images ?? []} set={(images) => u({ images })} max={L.galleryImages} make={() => ({ url: '' })} render={(it, upd) => (
            <>
              <ImgField label="Picture" value={it.url} onChange={(v) => upd({ ...it, url: v })} p={p} reload={reload} />
              <Txt label="Caption (optional)" value={it.caption} onChange={(v) => upd({ ...it, caption: v })} max={L.caption} />
            </>
          )} />
        </>
      );
    case 'compare':
      return (
        <>
          {title}
          <ImgField label="Before picture" value={b.before?.url} onChange={(v) => u({ before: { ...b.before, url: v } })} p={p} reload={reload} />
          <Txt label="Before label" value={b.before?.label} onChange={(v) => u({ before: { ...b.before, label: v } })} max={L.label} />
          <ImgField label="After picture" value={b.after?.url} onChange={(v) => u({ after: { ...b.after, url: v } })} p={p} reload={reload} />
          <Txt label="After label" value={b.after?.label} onChange={(v) => u({ after: { ...b.after, label: v } })} max={L.label} />
          <Txt label="Caption (optional)" value={b.caption} onChange={(v) => u({ caption: v })} max={L.caption} />
        </>
      );
    case 'video':
      return (
        <>
          {title}
          <Txt label="Video link (YouTube, Vimeo or Streamable)" value={b.url} onChange={(v) => u({ url: v })} max={L.url} hint="Loads only after a click; nothing is requested from the video site before." />
          <ImgField label="Poster picture (optional)" value={b.poster} onChange={(v) => u({ poster: v })} p={p} reload={reload} />
          <Txt label="Caption (optional)" value={b.caption} onChange={(v) => u({ caption: v })} max={L.caption} />
        </>
      );
    case 'text':
      return (
        <>
          {title}
          <Txt label="Text" area value={b.markdown} onChange={(v) => u({ markdown: v })} max={L.markdown}
            hint={`${(b.markdown ?? '').length} / ${L.markdown}. Headings (# to ####), lists, **bold**, *italic*, \`code\`, code fences and [links](https://...). Nothing else.`} />
        </>
      );
    case 'compat':
      return (
        <>
          {title}
          <ListEditor<any> noun="game" items={b.rows ?? []} set={(rows) => u({ rows })} max={L.compatRows} make={() => ({ game: 'tmnf', status: 'works' })} render={(it, upd) => (
            <div className="row top">
              <Field label="Game"><select value={it.game} onChange={(e) => upd({ ...it, game: e.target.value })}>{HUB_GAMES.map((g) => <option key={g}>{g}</option>)}</select></Field>
              <Field label="Status"><select value={it.status} onChange={(e) => upd({ ...it, status: e.target.value })}>{COMPAT_STATUS.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <div className="grow"><Txt label="Note (optional)" value={it.note} onChange={(v) => upd({ ...it, note: v })} max={L.note} /></div>
            </div>
          )} />
        </>
      );
    case 'hotkeys':
      return (
        <>
          {title}
          <ListEditor noun="key" items={b.rows ?? []} set={(rows) => u({ rows })} max={L.hotkeyRows} make={() => ({ keys: '', action: '' })} render={(it, upd) => (
            <div className="row top">
              <Txt label="Keys, e.g. Ctrl+F5" value={it.keys} onChange={(v) => upd({ ...it, keys: v })} max={L.keys} />
              <div className="grow"><Txt label="Action" value={it.action} onChange={(v) => upd({ ...it, action: v })} max={L.action} /></div>
            </div>
          )} />
        </>
      );
    case 'changelog':
      return (
        <>
          {title}
          <Field label="How many versions"><select value={b.count ?? 1} onChange={(e) => u({ count: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select></Field>
        </>
      );
    case 'faq':
      return (
        <>
          {title}
          <ListEditor noun="question" items={b.items ?? []} set={(items) => u({ items })} max={L.faqItems} make={() => ({ q: '', a: '' })} render={(it, upd) => (
            <>
              <Txt label="Question" value={it.q} onChange={(v) => upd({ ...it, q: v })} max={L.question} />
              <Txt label="Answer" area value={it.a} onChange={(v) => upd({ ...it, a: v })} max={L.answer} />
            </>
          )} />
        </>
      );
    case 'cta':
      return (
        <>
          {title}
          <Txt label="Text (optional)" value={b.text} onChange={(v) => u({ text: v })} max={L.ctaText} />
          <ListEditor noun="button" items={b.buttons ?? []} set={(buttons) => u({ buttons })} max={L.ctaButtons} make={() => ({ kind: 'link', label: '', url: '' })} render={(it, upd) => (
            <div className="row top">
              <Field label="Kind" hint={it.kind === 'install' ? 'Starts the install.' : it.kind === 'companion' ? 'Opens the companion link of the mod (or the link below).' : undefined}>
                <select value={it.kind} onChange={(e) => upd({ ...it, kind: e.target.value })}>{CTA_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
              </Field>
              <div className="grow"><Txt label="Label" value={it.label} onChange={(v) => upd({ ...it, label: v })} max={L.ctaLabel} /></div>
              {it.kind !== 'install' && <div style={{ flexBasis: '100%' }}><Txt label="Link (https)" value={it.url} onChange={(v) => upd({ ...it, url: v })} max={L.url} /></div>}
            </div>
          )} />
        </>
      );
  }
}

function BlockCard({ i, n, b, set, move, remove, issues, p, reload }: { i: number; n: number; b: Blk; set: (b: Blk) => void; move: (d: number) => void; remove: () => void; issues: ShowcaseIssue[]; p: HubProject; reload: () => void }) {
  return (
    <div className="card" data-testid={`block-${i}`}>
      <div className="row" style={{ marginBottom: 'var(--tm-s-2)' }}>
        <b>{i + 1}. {TYPE_LABEL[b.type]}</b>
        {issues.length > 0 && <Badge tone="warn">{issues.length} to fix</Badge>}
        <span className="right row" style={{ gap: 4 }}>
          <button type="button" className="btn icon" disabled={i === 0} onClick={() => move(-1)} aria-label="Move block up"><ArrowUp size={14} /></button>
          <button type="button" className="btn icon" disabled={i === n - 1} onClick={() => move(1)} aria-label="Move block down"><ArrowDown size={14} /></button>
          <button type="button" className="btn icon danger" onClick={remove} aria-label="Remove block"><Trash2 size={14} /></button>
        </span>
      </div>
      {HINT[b.type] && <p className="muted small">{HINT[b.type]}</p>}
      {issues.length > 0 && <ul className="msg err" style={{ paddingLeft: 24 }}>{issues.map((x, k) => <li key={k}><code>{x.path.replace(/^blocks\[\d+\]\.?/, '') || 'block'}</code>: {x.message}</li>)}</ul>}
      <BlockFields b={b} set={set} p={p} reload={reload} />
    </div>
  );
}

// ---------------------------------------------------------------- tab

/** A first page to edit: hero, features, the project's pictures, compatibility, latest changes and an install button. */
function starter(p: HubProject): Doc {
  const pics = [p.banner, ...p.gallery].filter((x): x is HubImage => !!x);
  const blocks: Blk[] = [
    { type: 'hero', title: p.name.slice(0, L.heroTitle), tagline: p.summary.slice(0, L.tagline), ...(pics[0] ? { image: pics[0].url } : {}) },
    { type: 'features', title: 'What it does', items: [
      { icon: 'sparkles', title: 'First feature', text: 'One sentence about what players get.' },
      { icon: 'zap', title: 'Second feature', text: 'One sentence about what players get.' },
      { icon: 'settings', title: 'Third feature', text: 'One sentence about what players get.' },
    ] },
  ];
  if (p.gallery.length) blocks.push({ type: 'gallery', title: 'Screenshots', images: p.gallery.slice(0, 6).map((g) => ({ url: g.url })) });
  if (p.games.length) blocks.push({ type: 'compat', title: 'Works with', rows: p.games.slice(0, L.compatRows).map((g) => ({ game: g, status: 'works' })) });
  blocks.push({ type: 'changelog', count: 1 }, { type: 'cta', buttons: [{ kind: 'install', label: 'Install' }] });
  return { version: 1, theme: { accent: 'blue' }, blocks };
}

const viewCtx = (p: HubProject) => ({ onInstall: () => {}, companion: p.links.related?.find((l) => l.kind === 'companion') ?? null, gameName: (id: string) => id, releases: [{ version: p.latest ?? p.slug, notes: 'Release notes of your newest versions show here.' }] });

/** Showcase for people who cannot edit it (visitors of an unclaimed project, uploaders): the page as players see it, or why there is none. */
function ShowcaseReadOnly({ p }: { p: HubProject }) {
  const scheme = useScheme();
  if (p.showcase) {
    return (
      <>
        <Notice>{p.showcaseFrom === 'catalog' ? 'This page comes from the TM Horizon catalog.' : 'The showcase page of this project.'} {p.claimed ? 'Owners and maintainers can change it.' : 'Claim the project to change it.'}</Notice>
        <ShowcaseView showcase={p.showcase} scheme={scheme} ctx={viewCtx(p)} />
      </>
    );
  }
  return <EmptyState title="No showcase yet" text={p.catalogShowcase ? 'The TM Horizon catalog has a showcase for this project. Claim the project to use it.' : p.claimed ? 'Owners and maintainers can add one here.' : 'Claim the project to add one.'} />;
}

export function ShowcaseTab({ p, reload, readOnly }: { p: HubProject; reload: () => void; readOnly?: boolean }) {
  if (readOnly) return <ShowcaseReadOnly p={p} />;
  return <ShowcaseEditor p={p} reload={reload} />;
}

function ShowcaseEditor({ p, reload }: { p: HubProject; reload: () => void }) {
  const scheme = useScheme();
  const hasRepo = p.sources.some((s) => s.kind === 'github');
  const initial: Doc = p.showcase ? { version: 1, theme: p.showcase.theme, blocks: p.showcase.blocks as Blk[] } : { version: 1, theme: { accent: 'blue' }, blocks: [] };
  const [doc, setDoc] = useState<Doc>(initial);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [add, setAdd] = useState<ShowcaseBlockType>('hero');
  const [json, setJson] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ShowcaseIssue[] | null>(null);
  const { busy, error, run } = useAction();

  const hosts = useMemo(() => [...new Set([p.icon, p.banner, ...p.gallery].filter((x): x is HubImage => !!x).map((x) => hostOf(x.url)).filter(Boolean))], [p]);
  const pruned = useMemo(() => prune(doc), [doc]);
  const result = useMemo(() => validateShowcase(pruned, { imageHosts: hosts }), [pruned, hosts]);
  const change = (d: Doc) => { setDoc(d); setDirty(true); setSaved(false); setServerIssues(null); };
  const setBlock = (i: number, b: Blk) => change({ ...doc, blocks: doc.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, d: number) => { const n = [...doc.blocks]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; change({ ...doc, blocks: n }); };
  const issuesFor = (i: number) => (serverIssues ?? result.issues).filter((x) => x.path === `blocks[${i}]` || x.path.startsWith(`blocks[${i}].`));
  const general = (serverIssues ?? result.issues).filter((x) => !/^blocks\[\d+\]/.test(x.path));
  const heroCount = doc.blocks.filter((b) => b.type === 'hero').length;

  const save = () => void run(async () => {
    try {
      await api.putShowcase(p.slug, pruned);
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { issues?: ShowcaseIssue[] } | undefined) : undefined;
      if (d?.issues) setServerIssues(d.issues);
      throw e;
    }
    setDirty(false);
    setSaved(true);
    reload();
  });
  const adopt = (from: 'repo' | 'catalog') => void run(async () => {
    if ((p.showcase || doc.blocks.length) && !window.confirm(from === 'catalog' ? 'Replace this page with the showcase from the TM Horizon catalog?' : 'Replace this page with showcase.json from your repository?')) return;
    const r = await api.adoptShowcase(p.slug, from);
    const s = r.showcase as Doc;
    setDoc({ version: 1, theme: s.theme, blocks: s.blocks });
    setDirty(false);
    setSaved(false);
    reload();
  });
  const remove = () => void run(async () => {
    if (!window.confirm('Remove the showcase page of this mod?')) return;
    await api.deleteShowcase(p.slug);
    setDoc({ version: 1, theme: { accent: 'blue' }, blocks: [] });
    setDirty(false);
    reload();
  });

  return (
    <div className="sc-editor">
      <div>
        <div className="card">
          <h2>Showcase page</h2>
          <p className="muted small">
            A page for your mod, shown above the usual sections in the launcher and on the website. Blocks only, no HTML. Up to {L.blocks} blocks.
            You can also keep a <code>showcase.json</code> in your repository; the hub reads it. See <code>docs/hub/showcase.md</code>.
          </p>
          {p.showcaseFrom === 'repo' && <div className="msg">This page comes from <code>showcase.json</code> (or plugin.json) in your repository and is refreshed from there. Saving here replaces it and stops the refresh.</div>}
          {p.showcaseFrom === 'catalog' && <div className="msg">This page comes from the TM Horizon catalog. Change it and save to make it yours; a <code>showcase.json</code> in your repository would replace it.</div>}
          {(p.catalogShowcase || hasRepo) && doc.blocks.length > 0 && (
            <div className="row" style={{ marginBottom: 'var(--tm-s-3)' }}>
              {p.catalogShowcase && p.showcaseFrom !== 'catalog' && <button className="btn sm" disabled={busy} onClick={() => adopt('catalog')}><BookCopy size={14} /> Copy from catalog</button>}
              {hasRepo && <button className="btn sm" disabled={busy} onClick={() => adopt('repo')}><Github size={14} /> Use showcase.json</button>}
            </div>
          )}
          <div className="row">
            <Field label="Accent colour">
              <div className="row" role="radiogroup" aria-label="Accent colour">
                {ACCENTS.map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={doc.theme?.accent === a} className={'sc-sw' + (doc.theme?.accent === a ? ' on' : '')} data-accent={a}
                    title={a} aria-label={a} onClick={() => change({ ...doc, theme: { accent: a } })} />
                ))}
              </div>
            </Field>
          </div>
          {general.length > 0 && doc.blocks.length > 0 && <ul className="msg err" style={{ paddingLeft: 24 }}>{general.map((x, k) => <li key={k}>{x.path ? <code>{x.path}</code> : null} {x.message}</li>)}</ul>}
          {error && <div className="msg err" role="alert">{error}</div>}
          {saved && <div className="msg ok">Saved. The launcher picks it up with the next index refresh.</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || !dirty || !result.ok} onClick={save}>{busy ? 'Saving' : 'Save'}</button>
            {p.showcase && <button className="btn danger" disabled={busy} onClick={remove}>Remove page</button>}
            <button className="btn ghost sm right" onClick={() => setJson(json === null ? JSON.stringify(pruned, null, 2) : null)}>{json === null ? 'Show JSON' : 'Hide JSON'}</button>
          </div>
          {!result.ok && dirty && <p className="muted small">Fix the marked fields to save.</p>}
          {json !== null && (
            <div className="stack" style={{ marginTop: 'var(--tm-s-3)' }}>
              <textarea className="mono" rows={12} value={json} onChange={(e) => setJson(e.target.value)} aria-label="Showcase JSON" />
              <button className="btn sm" onClick={() => {
                try {
                  const j = JSON.parse(json) as Doc;
                  if (!j || typeof j !== 'object' || !Array.isArray(j.blocks)) throw new Error('needs a "blocks" list');
                  change({ version: 1, theme: j.theme, blocks: j.blocks });
                  setJson(null);
                } catch (e) { window.alert(`Not a showcase: ${(e as Error).message}`); }
              }}>Apply JSON</button>
            </div>
          )}
        </div>

        {doc.blocks.length === 0 && (
          <EmptyState icon={<LayoutTemplate size={28} />} title="No showcase yet"
            text="A showcase is the big page of your mod in the launcher and on the website: a header picture, features, screenshots, buttons. Start from a template and change the texts."
            action={<div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => change(starter(p))}><LayoutTemplate size={15} /> Start from template</button>
              {p.catalogShowcase && <button className="btn" disabled={busy} onClick={() => adopt('catalog')}><BookCopy size={15} /> Copy from catalog</button>}
              {hasRepo && <button className="btn" disabled={busy} onClick={() => adopt('repo')}><Github size={15} /> Use showcase.json</button>}
            </div>} />
        )}
        {doc.blocks.map((b, i) => (
          <BlockCard key={i} i={i} n={doc.blocks.length} b={b} set={(nb) => setBlock(i, nb)} move={(d) => move(i, d)} remove={() => change({ ...doc, blocks: doc.blocks.filter((_, j) => j !== i) })}
            issues={issuesFor(i)} p={p} reload={reload} />
        ))}

        <div className="card">
          <div className="row">
            <select value={add} onChange={(e) => setAdd(e.target.value as ShowcaseBlockType)} aria-label="Block type">
              {BLOCK_TYPES.map((t) => <option key={t} value={t} disabled={t === 'hero' && heroCount > 0}>{TYPE_LABEL[t]}</option>)}
            </select>
            <button className="btn" disabled={doc.blocks.length >= L.blocks || (add === 'hero' && heroCount > 0)} onClick={() => change({ ...doc, blocks: [...doc.blocks, fresh(add, p)] })}><Plus size={14} /> Add block</button>
            <span className="muted small">{doc.blocks.length} / {L.blocks}</span>
          </div>
        </div>
      </div>

      <div className="sc-preview" aria-label="Preview">
        <div className="muted small" style={{ marginBottom: 8 }}>Preview, as in the launcher. Blocks with problems are left out.</div>
        {result.showcase
          ? <ShowcaseView showcase={result.showcase} scheme={scheme} ctx={viewCtx(p)} />
          : <EmptyState title="Nothing to show yet" text="The preview appears as soon as a block is valid." />}
      </div>
    </div>
  );
}
