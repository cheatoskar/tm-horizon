import { useEffect, useRef, useState } from 'react';

export type CropKind = 'icon' | 'banner' | 'gallery';
export const CROP_SIZE: Record<CropKind, { w: number; h: number; label: string }> = {
  icon: { w: 512, h: 512, label: 'Icon (square)' },
  banner: { w: 1600, h: 500, label: 'Banner (16:5)' },
  gallery: { w: 1280, h: 720, label: 'Screenshot (16:9)' },
};

/** Crops a picture to a fixed aspect: drag to move, slider to zoom. Exports a WebP (PNG as fallback) blob. */
export function ImageCropper({ file, kind, onDone, onCancel }: { file: File; kind: CropKind; onDone: (blob: Blob, ext: string) => void; onCancel: () => void }) {
  const { w: OW, h: OH } = CROP_SIZE[kind];
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 }); // image centre offset from frame centre, in output pixels
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const DW = Math.min(520, OW);
  const DH = Math.round((DW * OH) / OW);

  useEffect(() => {
    let live = true;
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => live && setImg(i);
    i.onerror = () => live && setErr('This file is not a picture the browser can open.');
    i.src = url;
    return () => { live = false; URL.revokeObjectURL(url); };
  }, [file]);

  const geometry = (z: number, o: { x: number; y: number }) => {
    const base = Math.max(OW / img!.naturalWidth, OH / img!.naturalHeight);
    const s = base * z;
    const w = img!.naturalWidth * s;
    const h = img!.naturalHeight * s;
    const mx = (w - OW) / 2;
    const my = (h - OH) / 2;
    const ox = Math.max(-mx, Math.min(mx, o.x));
    const oy = Math.max(-my, Math.min(my, o.y));
    return { w, h, ox, oy, x: (OW - w) / 2 + ox, y: (OH - h) / 2 + oy };
  };

  const paint = (c: HTMLCanvasElement, scale: number) => {
    const g = geometry(zoom, off);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img!, g.x * scale, g.y * scale, g.w * scale, g.h * scale);
  };

  useEffect(() => {
    if (img && canvas.current) paint(canvas.current, DW / OW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom, off]);

  const exportBlob = () => {
    const c = document.createElement('canvas');
    c.width = OW; c.height = OH;
    paint(c, 1);
    c.toBlob((b) => {
      if (b && b.type === 'image/webp') return onDone(b, 'webp');
      c.toBlob((p) => (p ? onDone(p, 'png') : setErr('Could not export the picture.')), 'image/png');
    }, 'image/webp', 0.9);
  };

  if (err) return <div className="msg err">{err} <button className="btn sm" onClick={onCancel}>Back</button></div>;
  if (!img) return <div className="center"><span className="spinner" /> Opening</div>;
  const small = img.naturalWidth < OW / 2 || img.naturalHeight < OH / 2;
  return (
    <div className="stack">
      <canvas
        ref={canvas} className="cropper" width={DW} height={DH} style={{ width: DW, maxWidth: '100%', aspectRatio: `${OW} / ${OH}` }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: geometry(zoom, off).ox, oy: geometry(zoom, off).oy }; }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const k = OW / (e.currentTarget.getBoundingClientRect().width || DW);
          setOff({ x: drag.current.ox + (e.clientX - drag.current.x) * k, y: drag.current.oy + (e.clientY - drag.current.y) * k });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      />
      <div className="row" style={{ maxWidth: DW }}>
        <span className="small muted">Zoom</span>
        <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ flex: 1 }} aria-label="Zoom" />
      </div>
      {small && <div className="hint">This picture is small and will look blurry.</div>}
      <div className="row">
        <button className="btn primary" onClick={exportBlob}>Use crop</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <span className="hint">{CROP_SIZE[kind].label}, {OW} x {OH}</span>
      </div>
    </div>
  );
}
