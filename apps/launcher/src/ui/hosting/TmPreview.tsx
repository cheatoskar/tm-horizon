import { useMemo, type CSSProperties, type RefObject } from 'react';
import { parseTm, stripTm, tmLength, tmWarnings, TM_COLORS } from '../../data/tmformat.ts';
import { useT } from '../../i18n';

/** `safe`: colours are mixed with the theme's text colour (readable on light and dark) and links stay plain text. */
export function TmRich({ text, safe = false }: { text: string; safe?: boolean }) {
  const segs = useMemo(() => parseTm(text), [text]);
  return (
    <>
      {segs.map((s, i) => {
        const style: CSSProperties = {};
        if (s.color) style.color = safe ? `color-mix(in srgb, ${s.color} 62%, var(--fg))` : s.color;
        if (s.bold) style.fontWeight = 800;
        if (s.italic) style.fontStyle = 'italic';
        if (s.wide) { style.letterSpacing = '0.12em'; style.fontStretch = '125%'; }
        if (s.narrow) { style.letterSpacing = '-0.04em'; style.fontStretch = '75%'; }
        if (s.shadow) style.textShadow = '1px 1px 0 #000a';
        if (s.upper) style.textTransform = 'uppercase';
        if (s.link !== null && !safe) style.textDecoration = 'underline';
        return <span key={i} style={style} title={safe ? undefined : s.link ?? undefined}>{s.text}</span>;
      })}
    </>
  );
}

export function TmPreview({ text, kind }: { text: string; kind: 'name' | 'comment' | 'chat' }) {
  const t = useT();
  const plain = stripTm(text);
  const warnings = tmWarnings(text);
  return (
    <div className="hs-prev-wrap">
      <div className={`hs-prev hs-prev-${kind}`}>
        {kind === 'chat' && <span className="hs-prev-nick">[Player]</span>}
        {text ? <TmRich text={text} /> : <span className="hs-prev-empty">{t('hostfmt.empty')}</span>}
      </div>
      <div className="hs-prev-meta dim">
        <span>{plain ? `${plain} (${t('hostfmt.length', { n: tmLength(text) })})` : t('hostfmt.length', { n: 0 })}</span>
        {warnings.map((w) => <span key={w} className="hs-warn">{t(`hostfmt.warn.${w}`)}</span>)}
      </div>
    </div>
  );
}

type FieldEl = HTMLInputElement | HTMLTextAreaElement;

export function TmFormatBar({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef: RefObject<FieldEl> }) {
  const t = useT();
  const insert = (code: string) => {
    const el = inputRef.current;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, a) + code + value.slice(b));
    const pos = a + code.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };
  const fromColor = (hex: string) => {
    const h = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) / 17).toString(16)).join('');
    insert('$' + h);
  };
  const codes: [string, string][] = [
    ['$o', 'bold'], ['$i', 'italic'], ['$w', 'wide'], ['$n', 'narrow'], ['$s', 'shadow'], ['$t', 'upper'],
    ['$z', 'reset'], ['$$', 'dollar'], ['$l', 'link'],
  ];
  return (
    <div className="hs-fbar">
      {TM_COLORS.map((c) => (
        <button key={c.code} type="button" className="hs-swatch" style={{ background: '#' + c.code.slice(1) }} title={`${c.name} ${c.code}`} aria-label={c.code} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(c.code)} />
      ))}
      <input type="color" className="hs-colorpick" title={t('hostfmt.tip.color')} defaultValue="#ff0000" onChange={(e) => fromColor(e.target.value)} />
      {codes.map(([code, id]) => (
        <button key={code} type="button" className="hs-code" title={t(`hostfmt.tip.${id}`)} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(code === '$l' ? '$l[]' : code)}>{code}</button>
      ))}
    </div>
  );
}
