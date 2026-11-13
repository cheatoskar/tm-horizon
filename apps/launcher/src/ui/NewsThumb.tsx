import { Newspaper, Package } from 'lucide-react';
import type { NewsItem } from '../data/hub';
import { GameArt, useCachedImage } from './common';
import type { GameView } from '../data/types';

/** Fixed 16:9 picture of a news row: the item's own image; exchange posts fall back to their site's game art,
 * releases to a plain placeholder (never a game cover, a tool is not tied to one game). */
export function NewsThumb({ n, game }: { n: NewsItem; game?: GameView }) {
  const src = useCachedImage(n.image);
  if (n.image && src) return <span className="nwt"><img src={src} alt="" loading="lazy" decoding="async" /></span>;
  if (n.kind === 'exchange' && game) return <GameArt game={game} variant="thumb" className="nwt" />;
  return <span className="nwt ph">{n.kind === 'release' ? <Package size={22} strokeWidth={1.4} /> : <Newspaper size={22} strokeWidth={1.4} />}</span>;
}
