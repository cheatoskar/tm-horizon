// Rendered Markdown (READMEs, release notes, update notes): the shared renderer of packages/showcase-ui with
// the launcher's hooks: pictures through the local picture cache (badges and SVGs left out, the cache refuses
// SVG), links in the system browser, large pictures open the lightbox.
import { useState } from 'react';
import { ReadmeView } from '@tm-hub/showcase-ui';
import '@tm-hub/showcase-ui/readme.css';
import { ImageLightbox } from '../pages/Gallery';
import { backend } from '../data/backend';

const loadImage = (url: string) => backend.image!(url);

/** `title` is the mod's name: a README's first H1 that repeats it is left out. */
export function Markdown({ text, className = '', title }: { text: string; className?: string; title?: string }) {
  const [zoom, setZoom] = useState<string | null>(null);
  return (
    <>
      <ReadmeView
        source={text} className={className} title={title} dropBadges httpsOnly lazySrc
        loadImage={backend.image ? loadImage : undefined}
        onLink={(u) => void backend.openExternal(u)} onZoom={setZoom}
      />
      {zoom && <ImageLightbox url={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}
