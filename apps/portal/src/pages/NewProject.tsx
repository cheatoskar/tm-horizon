import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, Minus } from 'lucide-react';
import { PROJECT_TYPES, type GameId, type HubInstall, type HubProject, type HubProjectType, type SourcePreview } from '@tm-hub/shared';
import type { RelatedLink } from '@tm-hub/shared/links';
import { ShowcaseView } from '@tm-hub/showcase-ui';
import { api, type ImportBody } from '../api.ts';
import { Badge, Field, Notice, PageHead, useAction } from '../ui/common.tsx';
import { Checkbox, RadioCards, Section } from '../ui/controls.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { DEFAULT_INSTALL, GamePicker, InstallSelect } from '../ui/InstallEditor.tsx';
import { EMPTY_INPUT, ProjectForm } from '../ui/ProjectForm.tsx';
import { TypePicker, fmtCount, typeLabel } from '../ui/ProjectType.tsx';
import { useScheme } from '../ui/theme.ts';
import { GAME_LABELS, fmtDay, fmtSize } from '../labels.ts';

const FROM_LABEL = { readme: 'README', release: 'Release', docs: 'docs/images' } as const;
const MAX_PICTURES = 12;
const README_CAP = 20000;

interface LinkItem { key: string; label: string; sub: string; url: string; set: (l: NonNullable<ImportBody['links']>) => void }

/** A card with an on/off checkbox in its header; switched off, the content is greyed. */
function Item({ title, help, on, onChange, checkLabel, children }: {
  title: ReactNode; help?: ReactNode; on: boolean; onChange: (v: boolean) => void; checkLabel: string; children: ReactNode;
}) {
  return (
    <Section title={title} help={help} actions={<Checkbox checked={on} onChange={onChange} label={checkLabel} />}>
      <div className={on ? '' : 'imp-off'}>{children}</div>
    </Section>
  );
}

function ShowcasePreview({ pv, which }: { pv: SourcePreview; which: 'repo' | 'catalog' }) {
  const scheme = useScheme();
  const showcase = which === 'repo' ? pv.showcase : pv.catalogShowcase;
  if (!showcase) return null;
  return (
    <details className="imp-details">
      <summary>Preview</summary>
      <div className="imp-showcase">
        <ShowcaseView showcase={showcase} scheme={scheme} ctx={{ onInstall: () => {}, companion: pv.links.related?.find((l) => l.kind === 'companion') ?? null, gameName: (id) => id, releases: [{ version: pv.latest?.version ?? '1.0.0', notes: 'Release notes of your newest versions show here.' }] }} />
      </div>
    </details>
  );
}

const CATALOG_NOTE = /Imported from the TM Horizon catalog/;

/**
 * The import preview. Without `existing` it creates a project. With `existing` ("Import from GitHub" on the project page)
 * the same items are offered, nothing is ticked that would overwrite what the owner wrote, and only the ticked items are applied.
 */
export function Preview({ pv, url, onProduct, existing }: { pv: SourcePreview; url: string; onProduct: (p: string) => void; existing?: HubProject }) {
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const github = pv.kind === 'github';

  const [type, setType] = useState<HubProjectType | null>(existing ? existing.type ?? null : pv.type);
  const [name, setName] = useState(pv.name);
  const [slug, setSlug] = useState(pv.slug);
  const [summary, setSummary] = useState(pv.summary);
  const [useSummary, setUseSummary] = useState(false);
  const [useReadme, setUseReadme] = useState(pv.description.trim().length > 0 && (!existing || !existing.description.trim() || CATALOG_NOTE.test(existing.description)));
  const [picked, setPicked] = useState<string[]>(existing && existing.gallery.length ? [] : pv.images.slice(0, MAX_PICTURES));
  const [banner, setBanner] = useState<string | null>(null);
  const [useLicense, setUseLicense] = useState(!!pv.license && !existing?.license);
  const [offLinks, setOffLinks] = useState<string[]>(() => existing ? ['source', 'issues', 'homepage', 'discord'].filter((k) => (existing.links as Record<string, unknown>)[k]) : []);
  const [newest, setNewest] = useState(!!pv.latest);
  const [asset, setAsset] = useState<string | null>(pv.asset);
  const [games, setGames] = useState<GameId[]>(existing && existing.games.length ? existing.games : []);
  const [install, setInstall] = useState<HubInstall>(pv.install ?? DEFAULT_INSTALL);
  const hasRepo = !!pv.showcase;
  const hasCatalog = !!pv.catalogShowcase;
  const [showcase, setShowcase] = useState<'repo' | 'catalog' | null>(hasRepo ? 'repo' : hasCatalog ? 'catalog' : null);
  const needsProduct = pv.kind === 'tmloader' && !pv.product;

  const linkItems = useMemo<LinkItem[]>(() => {
    const out: LinkItem[] = [];
    const l = pv.links;
    if (l.source) out.push({ key: 'source', label: 'Source', sub: l.source, url: l.source, set: (o) => { o.source = l.source; } });
    if (l.issues) out.push({ key: 'issues', label: 'Issues', sub: l.issues, url: l.issues, set: (o) => { o.issues = l.issues; } });
    if (l.homepage) out.push({ key: 'homepage', label: 'Homepage', sub: l.homepage, url: l.homepage, set: (o) => { o.homepage = l.homepage; } });
    if (l.discord) out.push({ key: 'discord', label: 'Discord', sub: l.discord, url: l.discord, set: (o) => { o.discord = l.discord; } });
    (l.related ?? []).forEach((r: RelatedLink, i) => out.push({
      key: `related-${i}`, label: r.label, sub: `${r.kind} · ${r.url}`, url: r.url,
      set: (o) => { o.related = [...(o.related ?? []), r]; },
    }));
    return out;
  }, [pv.links]);
  const chosenLinks = linkItems.filter((x) => !offLinks.includes(x.key));

  if (needsProduct) {
    return (
      <div className="card">
        <h2>Pick a product</h2>
        <p className="muted">This TMLoader server has several products.</p>
        <div className="stack">
          {pv.products.map((p) => (
            <div className="row" key={p.id}>
              <b>{p.name}</b><span className="muted small">{p.versions} versions</span>
              <button className="btn sm right" onClick={() => onProduct(p.id)}>Use</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const delivery = type ? PROJECT_TYPES[type].delivery : null;
  const noInstall = delivery === 'browser' || delivery === 'link';
  // Apply mode: games and install type are asked only when the project has none (a release cannot be installed without them).
  const askInstall = !existing || (!noInstall && Object.keys(existing.installs).length === 0);
  const assetNeeded = github && newest && pv.assets.length > 1 && !asset;
  const summaryOk = summary.trim().length >= 10 && summary.trim().length <= 200;
  const nameOk = name.trim().length >= 2 && slug.trim().length >= 2;
  const toggle = (u: string) => setPicked((p) => {
    if (p.includes(u)) { if (banner === u) setBanner(null); return p.filter((x) => x !== u); }
    return p.length >= MAX_PICTURES ? p : [...p, u];
  });
  const move = (i: number, d: number) => setPicked((p) => {
    const j = i + d;
    if (j < 0 || j >= p.length) return p;
    const n = [...p];
    [n[i], n[j]] = [n[j]!, n[i]!];
    return n;
  });
  const gallery = picked.filter((u) => u !== banner);

  const reason = existing ? (askInstall && games.length === 0 ? 'Pick at least one game.' : null)
    : pv.existing ? (pv.existing.claimed ? `Already imported as "${pv.existing.slug}". New releases come in by themselves; open that project to see them (a first version waits for review).` : 'Already on the hub. Claim that project instead of importing a second one.')
    : !type ? 'Pick a type.'
    : !nameOk ? 'Name and URL name need at least 2 characters.'
    : !summaryOk ? 'The summary needs 10 to 200 characters.'
    : askInstall && games.length === 0 ? 'Pick at least one game.'
    : assetNeeded ? 'Pick the release file.'
    : null;

  const assetOf = (n: string | null) => pv.assetInfo.find((a) => a.name === n);
  const lines: { on: boolean; text: string }[] = [
    ...(existing ? [{ on: useSummary, text: useSummary ? 'Short description from the repository' : 'Short description stays' }] : [
      { on: !!type, text: `Type: ${type ? typeLabel(type) : 'not chosen'}` },
      { on: true, text: 'Name, short description' }]),
    { on: useReadme, text: useReadme ? 'README as description' : 'No long description' },
  ];
  if (pv.images.length) lines.push({ on: picked.length > 0, text: picked.length ? `${picked.length} ${picked.length === 1 ? 'picture' : 'pictures'}${banner ? ` (banner: 1, gallery: ${gallery.length})` : ' (no banner)'}` : 'No pictures' });
  if (pv.license) lines.push({ on: useLicense, text: useLicense ? `Licence ${pv.license}` : 'No licence' });
  if (linkItems.length) lines.push({ on: chosenLinks.length > 0, text: chosenLinks.length ? `${chosenLinks.length} ${chosenLinks.length === 1 ? 'link' : 'links'}` : 'No links' });
  if (existing) lines.push({ on: true, text: `Repository ${pv.target} becomes the source; the newest release is checked now` });
  else if (pv.latest || !github) {
    if (!github) lines.push({ on: true, text: 'Versions from the TMLoader server' });
    else lines.push(newest && pv.latest
      ? { on: true, text: `Version ${pv.latest.version}${asset ? ` (${asset})` : ''}` }
      : { on: false, text: 'No version now, the next release comes in by itself' });
  }
  lines.push(showcase
    ? { on: true, text: showcase === 'repo' ? 'Showcase from the repository' : 'Showcase from the catalog' }
    : { on: false, text: 'No showcase' });
  if (askInstall) lines.push({ on: games.length > 0, text: games.length ? `Games: ${games.map((g) => GAME_LABELS[g]).join(', ')}` : 'Games: none chosen' });
  if (askInstall && !noInstall && games.length > 0) lines.push({ on: true, text: 'Install type from the form above' });

  const submit = () => run(async () => {
    const links: NonNullable<ImportBody['links']> = {};
    for (const l of chosenLinks) l.set(links);
    if (existing) {
      const r = await api.importGithub(existing.slug, {
        url,
        ...(useSummary && summaryOk ? { summary: summary.trim() } : {}),
        ...(useReadme ? { description: pv.description.slice(0, README_CAP) } : {}),
        ...(useLicense && pv.license ? { license: pv.license } : {}),
        ...(chosenLinks.length ? { links } : {}),
        ...(gallery.length ? { images: gallery } : {}),
        ...(banner ? { banner } : {}),
        ...(showcase ? { showcase } : {}),
        ...(askInstall && games.length ? { games, install } : {}),
        ...(asset ? { assetPattern: asset } : {}),
      });
      nav(`/projects/${existing.slug}?tab=versions`, { state: { pictureErrors: r.pictureErrors ?? [], imported: r.applied } });
      return;
    }
    const body: ImportBody = {
      url, product: pv.product, slug: slug.trim(), name: name.trim(), games, install, type: type!,
      summary: summary.trim(),
      description: useReadme ? pv.description.slice(0, README_CAP) : '',
      license: useLicense && pv.license ? pv.license : null,
      links,
      images: gallery, banner,
      showcase,
      importLatest: github ? newest && !!pv.latest : true,
      assetPattern: github && newest && asset && asset !== pv.asset ? asset : null,
    };
    const r = await api.importProject(body);
    nav(`/projects/${r.project.slug}`, { state: { pictureErrors: r.pictureErrors ?? [] } });
  });

  return (
    <>
      {pv.existing && !existing && (
        <Notice tone="warn">
          {pv.existing.viaRepo ? 'The hub already lists this repository as the project' : 'A hub project already watches this source:'} <b>{pv.existing.slug}</b>{pv.existing.claimed ? ' (claimed).' : ' (not claimed yet).'}{' '}
          {pv.existing.claimed ? <Link className="btn sm primary" to={`/projects/${pv.existing.slug}?tab=versions`}>Open it</Link> : <Link className="btn sm primary" to={`/projects/${pv.existing.slug}?tab=claim`}>Claim this project</Link>}
        </Notice>
      )}
      {pv.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}

      <Section title={pv.name} actions={<Badge tone="info">{github ? 'GitHub' : 'TMLoader'}</Badge>} help="Check each item below. Only what is checked is imported.">
        <table>
          <tbody>
            <tr><th>Source</th><td className="wrapword">{pv.target}{pv.product ? ` (${pv.product})` : ''}</td></tr>
            <tr><th>Author</th><td>{pv.author}</td></tr>
            <tr><th>Latest release</th><td>{pv.latest ? <>{pv.latest.version} <span className="muted small">({pv.latest.tag}, {fmtDay(pv.latest.published)}){pv.latest.prerelease ? ' pre-release' : ''}</span></> : <span className="muted">none yet</span>}</td></tr>
            {pv.githubDownloads !== null && <tr><th>GitHub downloads</th><td>{fmtCount(pv.githubDownloads)}</td></tr>}
          </tbody>
        </table>
      </Section>

      {!existing && <Section title="Type" help="Required. It decides how the launcher offers the project.">
        <TypePicker value={type} onChange={setType} />
        {pv.typeReason && <p className="hint" style={{ marginTop: 'var(--tm-s-2)', marginBottom: 0 }}>{pv.typeReason}</p>}
      </Section>}

      {existing ? (
        <Item title="Short description" on={useSummary} onChange={setUseSummary} checkLabel="Replace the short description"
          help={`Now: ${existing.summary}`}>
          <Field label="New text" hint={`${summary.trim().length} / 200, at least 10.`}>
            <textarea rows={2} value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} />
          </Field>
        </Item>
      ) : <Section title="Name and summary">
        <div className="cols2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={64} /></Field>
          <Field label="URL name" hint="Cannot be changed later."><input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
        </div>
        <Field label="Summary" hint={`${summary.trim().length} / 200, at least 10.`}>
          <textarea rows={2} value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </Section>}

      <Item title="Description" on={useReadme} onChange={setUseReadme} checkLabel="Use README as description"
        help={pv.description ? undefined : 'No README found.'}>
        {useReadme
          ? <div className="mdbox"><Markdown text={pv.description.slice(0, README_CAP)} /></div>
          : <p className="hint" style={{ margin: 0 }}>The description stays empty. You can write one later under Details.</p>}
      </Item>

      {pv.images.length > 0 && (
        <Section title="Pictures" help="Chosen pictures become the gallery in this order. The banner is the wide picture at the top of the project page (at least 640×160).">
          <div className="imp-tiles">
            {pv.images.map((u, i) => {
              const on = picked.includes(u);
              return (
                <label key={u} className={`imp-tile ${on ? 'on' : ''}`}>
                  <img src={u} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  <span className="imp-tile-bar">
                    <input type="checkbox" checked={on} onChange={() => toggle(u)} disabled={!on && picked.length >= MAX_PICTURES} aria-label={`Use picture ${i + 1}`} />
                    <span className="badge">{FROM_LABEL[pv.imageFrom[i] ?? 'readme']}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {picked.length > 0 && (
            <div className="imp-order">
              <div className="lbl">Order and banner</div>
              <ol>
                {picked.map((u, i) => (
                  <li key={u}>
                    <span className="imp-num">{i + 1}</span>
                    <img src={u} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    <label className="check imp-banner">
                      <input type="radio" name="banner" checked={banner === u} onChange={() => setBanner(u)} /> Banner
                    </label>
                    <span className="imp-move">
                      <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move picture ${i + 1} up`}><ChevronUp size={14} /></button>
                      <button type="button" className="btn sm ghost" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label={`Move picture ${i + 1} down`}><ChevronDown size={14} /></button>
                    </span>
                  </li>
                ))}
              </ol>
              <label className="check"><input type="radio" name="banner" checked={banner === null} onChange={() => setBanner(null)} /> No banner</label>
            </div>
          )}
        </Section>
      )}

      {pv.license && (
        <Item title="Licence" on={useLicense} onChange={setUseLicense} checkLabel={`Use licence ${pv.license}`}>
          <p className="hint" style={{ margin: 0 }}>Found in the repository: {pv.license}.</p>
        </Item>
      )}

      {linkItems.length > 0 && (
        <Section title="Links" help="Shown on the project page.">
          <div className="stack">
            {linkItems.map((l) => (
              <Checkbox key={l.key} checked={!offLinks.includes(l.key)} onChange={(v) => setOffLinks((o) => v ? o.filter((k) => k !== l.key) : [...o, l.key])}
                label={l.label} hint={<span className="wrapword">{l.sub}</span>} />
            ))}
          </div>
        </Section>
      )}

      {existing ? (
        <Section title="Releases" help="The repository is connected as the source of this project. New releases come in by themselves; each one still goes through the checks.">
          {pv.latest ? <p style={{ margin: 0 }}>Newest: <b>{pv.latest.version}</b> <span className="muted small">({pv.latest.tag}, {fmtDay(pv.latest.published)})</span>. It is fetched when you apply.</p> : <p className="hint" style={{ margin: 0 }}>No release found yet.</p>}
          {pv.assets.length > 1 && <p className="hint" style={{ marginBottom: 0 }}>Several files fit. You pick the one to install on the Versions tab after applying.</p>}
        </Section>
      ) : github ? (
        <Item title="Release" on={newest && !!pv.latest} onChange={(v) => pv.latest && setNewest(v)} checkLabel="Import the newest release now"
          help={pv.latest ? undefined : 'No release found yet.'}>
          {pv.latest && newest ? (
            <>
              <p style={{ marginTop: 0 }}><b>{pv.latest.version}</b> <span className="muted small">({pv.latest.tag}, {fmtDay(pv.latest.published)})</span> {pv.latest.prerelease && <Badge tone="warn">Pre-release</Badge>}</p>
              {pv.assets.length > 1 && (
                <RadioCards<string> name="asset" value={asset} onChange={setAsset} columns={1} ariaLabel="Release file"
                  options={pv.assets.map((a) => {
                    const info = assetOf(a);
                    return { value: a, label: <span className="wrapword">{a}</span>, meta: info ? `${fmtSize(info.size)} · ${fmtCount(info.downloads)} downloads` : undefined };
                  })} />
              )}
              {pv.assets.length === 1 && (
                <p className="hint" style={{ margin: 0 }}>File: <b className="wrapword">{pv.assets[0]}</b>{assetOf(pv.assets[0]!) ? ` (${fmtSize(assetOf(pv.assets[0]!)!.size)}, ${fmtCount(assetOf(pv.assets[0]!)!.downloads)} downloads)` : ''}</p>
              )}
              {pv.assets.length === 0 && <p className="hint" style={{ margin: 0 }}>No installable file in this release.</p>}
            </>
          ) : (
            <p className="hint" style={{ margin: 0 }}>The hub still watches the repository and imports the next release.</p>
          )}
        </Item>
      ) : (
        <Section title="Release" help="The hub reads all versions from the TMLoader server." />
      )}

      {askInstall && <Section title="Games and install" help="Which game is it for?">
        <GamePicker games={games} onChange={setGames} />
        {noInstall ? (
          <p className="hint" style={{ marginTop: 'var(--tm-s-3)', marginBottom: 0 }}>Not installed into a game. Games only say which game it is for.</p>
        ) : (
          <div style={{ marginTop: 'var(--tm-s-4)' }}>
            <div className="lbl">Install type</div>
            <InstallSelect value={install} onChange={setInstall} />
            {pv.installReason && <p className="hint" style={{ marginTop: 'var(--tm-s-2)', marginBottom: 0 }}>{pv.installReason}</p>}
          </div>
        )}
      </Section>}

      <Section title="Showcase" help={hasRepo || hasCatalog ? 'The page players see in the launcher.' : undefined}>
        {hasRepo || hasCatalog ? (
          <>
            <RadioCards<string> name="showcase" columns={1} ariaLabel="Showcase" value={showcase ?? 'none'}
              onChange={(v) => setShowcase(v === 'repo' || v === 'catalog' ? v : null)}
              options={[
                ...(hasRepo ? [{ value: 'repo', label: 'From the repository (showcase.json)' }] : []),
                ...(hasCatalog ? [{ value: 'catalog', label: 'From the TM Horizon catalog', hint: pv.catalog ? `Entry: ${pv.catalog.name}` : undefined }] : []),
                { value: 'none', label: 'No showcase' },
              ]} />
            {showcase && <ShowcasePreview pv={pv} which={showcase} />}
          </>
        ) : (
          <p className="hint" style={{ margin: 0 }}>No showcase found. You can make one later in the Showcase tab.</p>
        )}
      </Section>

      <Section title={existing ? 'What will be applied' : 'What will be imported'}>
        <ul className="imp-sum">
          {lines.map((l, i) => (
            <li key={i} className={l.on ? 'on' : 'off'}>
              {l.on ? <Check size={15} aria-hidden /> : <Minus size={15} aria-hidden />}
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
        {error && <Notice tone="err">{error}</Notice>}
        <div className="row">
          <button className="btn primary" disabled={busy || !!reason} onClick={() => void submit()}>{busy ? (existing ? 'Applying' : 'Importing') : (existing ? 'Apply' : 'Import')}</button>
          {reason && <span className="msg warn small" role="status" style={{ margin: 0 }}>{reason}</span>}
        </div>
        <p className="hint" style={{ marginTop: 'var(--tm-s-3)', marginBottom: 0 }}>The hub watches the repo from now on and picks up new releases by itself.</p>
      </Section>
    </>
  );
}

export function NewProjectPage() {
  const [url, setUrl] = useState('');
  const [pv, setPv] = useState<SourcePreview | null>(null);
  const [manual, setManual] = useState(false);
  const { busy, error, run } = useAction();
  const nav = useNavigate();

  const preview = (product?: string | null) => run(async () => { setPv(await api.preview(url, product)); });

  if (manual) {
    return (
      <div className="page narrow">
        <PageHead title="Create by hand">
          <button className="btn sm right" onClick={() => setManual(false)}>Paste a repo instead</button>
        </PageHead>
        <ProjectForm initial={EMPTY_INPUT} mode="create" submitLabel="Create" onSubmit={async (i) => { const p = await api.createProject(i); nav(`/projects/${p.slug}`); }} />
      </div>
    );
  }
  return (
    <div className="page narrow imp-page">
      <PageHead title="New project" />
      <div className="card">
        <h2>Paste your GitHub repo or TMLoader server URL</h2>
        <p className="muted">The hub reads the repo and shows what it found. You confirm each item before anything is imported. No tokens, keys or workflows needed.</p>
        <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); setPv(null); void preview(); }}>
          <input style={{ flex: 1 }} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Repository or server URL" />
          <button className="btn primary" disabled={busy || url.trim().length < 3}>{busy ? 'Looking' : 'Preview'}</button>
        </form>
        {error && <div className="msg err" style={{ marginTop: 'var(--tm-s-3)' }} role="alert">{error}</div>}
        <p className="small" style={{ marginTop: 'var(--tm-s-3)', marginBottom: 0 }}><button className="btn sm ghost" onClick={() => setManual(true)}>Create by hand</button></p>
      </div>
      {pv && <Preview key={pv.target + (pv.product ?? '')} pv={pv} url={url} onProduct={(p) => void preview(p)} />}
    </div>
  );
}
