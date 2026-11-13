import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { HubImage, HubProject } from '@tm-hub/shared';
import { api, upload } from '../../api.ts';
import { Field, Notice, useAction } from '../../ui/common.tsx';
import { EmptyState, FileDrop, Section } from '../../ui/controls.tsx';
import { CROP_SIZE, ImageCropper, type CropKind } from '../../ui/ImageCropper.tsx';
import { useAuth } from '../../auth.tsx';

function Picker({ slug, kind, onUploaded }: { slug: string; kind: CropKind; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const { busy, error, run } = useAction();
  const { config } = useAuth();
  return (
    <div className="stack">
      {error && <Notice tone="err">{error}</Notice>}
      {!file ? (
        <FileDrop accept="image/png,image/jpeg,image/webp,image/gif" file={null} onFile={setFile} label={`Choose a ${kind} picture`} hint="PNG, JPEG, WebP or GIF. You can crop it next." />
      ) : busy ? (
        <div className="center"><span className="spinner" /> Uploading</div>
      ) : (
        <>
          {kind === 'gallery' && <Field label="Caption (optional)"><input maxLength={120} value={caption} onChange={(e) => setCaption(e.target.value)} /></Field>}
          <ImageCropper file={file} kind={kind} onCancel={() => setFile(null)} onDone={(blob, ext) => void run(async () => {
            if (blob.size > config.maxImageMb * 1048576) throw new Error(`The picture is larger than ${config.maxImageMb} MB. Crop smaller or zoom in.`);
            const f = new FormData();
            f.append('kind', kind);
            if (caption) f.append('caption', caption);
            f.append('file', blob, `${kind}.${ext}`);
            await upload<HubImage>(`/v1/projects/${encodeURIComponent(slug)}/images`, f);
            setFile(null);
            setCaption('');
            onUploaded();
          })} />
        </>
      )}
    </div>
  );
}

function Single({ p, kind, current, reload }: { p: HubProject; kind: 'icon' | 'banner'; current: HubImage | null; reload: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Section title={kind === 'icon' ? 'Icon' : 'Banner'} help={`${CROP_SIZE[kind].label}. A new upload replaces the old one.`}>
      {error && <Notice tone="err">{error}</Notice>}
      {current && (
        <div className="row" style={{ marginBottom: 'var(--tm-s-4)' }}>
          <img src={current.url} alt="" style={kind === 'icon' ? { width: 96, height: 96, borderRadius: 16, objectFit: 'cover' } : { width: '100%', maxWidth: 480, aspectRatio: '16/5', objectFit: 'cover', borderRadius: 12 }} />
          <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => { await api.deleteImage(p.slug, current.id); reload(); })}>Delete</button>
        </div>
      )}
      <Picker slug={p.slug} kind={kind} onUploaded={reload} />
    </Section>
  );
}

export function ImagesTab({ p, reload }: { p: HubProject; reload: () => void }) {
  const { busy, error, run } = useAction();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const ids = p.gallery.map((g) => g.id);
  const order = (next: string[]) => void run(async () => { await api.orderImages(p.slug, next); reload(); });
  const move = (i: number, d: number) => {
    const n = [...ids];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j]!, n[i]!];
    order(n);
  };
  return (
    <>
      <Single p={p} kind="icon" current={p.icon} reload={reload} />
      <Single p={p} kind="banner" current={p.banner} reload={reload} />
      <Section title="Gallery" help={`${CROP_SIZE.gallery.label}, up to 12. Drag to reorder or use the arrows.`}>
        {error && <Notice tone="err">{error}</Notice>}
        {p.gallery.length === 0 && <EmptyState title="No screenshots yet" text="Add a few so people see what the mod does." />}
        {p.gallery.map((g, i) => (
          <div
            key={g.id} className={`thumbrow ${over === g.id ? 'dragover' : ''}`} draggable
            onDragStart={() => setDragId(g.id)}
            onDragOver={(e) => { e.preventDefault(); setOver(g.id); }}
            onDragLeave={() => setOver(null)}
            onDrop={() => {
              setOver(null);
              if (!dragId || dragId === g.id) return;
              const n = ids.filter((x) => x !== dragId);
              n.splice(n.indexOf(g.id) + (ids.indexOf(dragId) < i ? 1 : 0), 0, dragId);
              order(n);
            }}
          >
            <img src={g.url} alt={g.caption ?? ''} loading="lazy" />
            <div className="grow muted small wrapword">{g.caption ?? `${g.width} x ${g.height}`}</div>
            <button className="btn icon" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={14} /></button>
            <button className="btn icon" disabled={busy || i === ids.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={14} /></button>
            <button className="btn icon danger" disabled={busy} onClick={() => void run(async () => { await api.deleteImage(p.slug, g.id); reload(); })} aria-label="Delete"><Trash2 size={14} /></button>
          </div>
        ))}
        {p.gallery.length < 12 && (
          <div style={{ marginTop: 'var(--tm-s-5)', paddingTop: 'var(--tm-s-4)', borderTop: p.gallery.length ? '1px solid var(--line)' : undefined }}>
            <h3>Add a screenshot</h3>
            <Picker slug={p.slug} kind="gallery" onUploaded={reload} />
          </div>
        )}
      </Section>
    </>
  );
}
