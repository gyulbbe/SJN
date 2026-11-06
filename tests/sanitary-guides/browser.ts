/**
 * The page side of render.ts: a class's guides, drawn as the app draws its guide
 * (tests/direction-photo-methods/guide-variants.ts), as base64 PNGs. Browser only.
 */
import type { GuideInput } from '../../src/lib/direction-photo/guide-render';
import { renderModelGuides, renderVariantGuides } from '../direction-photo-methods/guide-variants';
import { createTrialShape } from '../direction-photo-methods/shapes';
import { directionsOf, type SanitaryClass } from './classes';
import { createSanitaryShape } from './shapes';

async function encode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export async function drawClass(c: SanitaryClass) {
  const directions = [...directionsOf(c)];
  const guides =
    c.model.from === 'app'
      ? await renderVariantGuides(
          {
            category: c.category as GuideInput['category'],
            form: c.model.form,
            ...(c.category === 'toilet' && { lid: 'closed' as const }),
            ...(c.model.skirt && { skirt: c.model.skirt }),
            sizeMm: c.sizeMm,
            installation: c.installation,
          },
          { model: 'b0' },
          directions,
        )
      : await renderModelGuides(
          c.model.from === 'trial'
            ? createTrialShape(c.model.shape, c.sizeMm)
            : createSanitaryShape(c.model.shape, c.sizeMm),
          c.installation,
          directions,
        );
  return Promise.all(
    guides.map(async (g) => ({
      direction: g.direction,
      width: g.width,
      height: g.height,
      png: await encode(g.blob),
    })),
  );
}
