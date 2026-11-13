// Browser side of statically rendered showcases (the website): the before/after slider and the click-to-load
// video buttons. In React apps the components do this themselves. Nothing is loaded before the click.
const EMBED = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d{5,12}|streamable\.com\/e\/[a-z0-9]{4,10})(\?[\w=&]*)?$/i;

export function enhanceShowcases(doc: Document = document): void {
  doc.addEventListener('input', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.matches?.('input[data-sc-compare-range]')) return;
    const box = el.closest<HTMLElement>('[data-sc-compare]');
    box?.style.setProperty('--pos', `${(el as HTMLInputElement).value}%`);
  });
  doc.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('button[data-sc-play]');
    const box = btn?.closest<HTMLElement>('[data-sc-video]');
    const src = box?.getAttribute('data-sc-video') ?? '';
    if (!btn || !box || !EMBED.test(src)) return;
    const f = doc.createElement('iframe');
    f.src = src;
    f.title = 'Video';
    f.loading = 'lazy';
    f.allow = 'autoplay; fullscreen; picture-in-picture';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    btn.replaceWith(f);
  });
}
