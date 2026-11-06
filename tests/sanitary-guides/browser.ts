/**
 * The page side of render.ts and prepare.ts: a class's guides, drawn as the app draws its guide
 * (tests/direction-photo-methods/guide-variants.ts), as base64 PNGs, and a photo prepared as the
 * material form prepares it (BiRefNet, then prepareReferenceImage). Browser only.
 */
import type { GuideInput } from '../../src/lib/direction-photo/guide-render';
import type { ProductDirection } from '../../src/lib/product-direction';
import { renderModelGuides, renderVariantGuides } from '../direction-photo-methods/guide-variants';
import { createTrialShape } from '../direction-photo-methods/shapes';
import { directionsOf, type SanitaryClass } from './classes';
import { createSanitaryShape } from './shapes';

export { prepareReferenceImage } from '../../src/lib/ai-export/client';
export { BackgroundRemovalClient } from '../../src/lib/background-removal/client';

export async function encode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export type DrawOptions = {
  /** Another size than the class's (a member's own catalogue size). */
  sizeMm?: [number, number, number];
  /** The app's standard model of this form instead of the class's shape (the trial's C0). */
  appForm?: string;
  directions?: ProductDirection[];
};

export async function drawClass(c: SanitaryClass, options: DrawOptions = {}) {
  const directions = options.directions ?? [...directionsOf(c)];
  const sizeMm = options.sizeMm ?? c.sizeMm;
  const app =
    options.appForm !== undefined
      ? { form: options.appForm, skirt: undefined }
      : c.model.from === 'app'
        ? { form: c.model.form, skirt: c.model.skirt }
        : undefined;
  const category = c.category === 'urinal' ? 'basin' : c.category;
  const guides = app
    ? await renderVariantGuides(
        {
          category: category as GuideInput['category'],
          form: app.form,
          ...(category === 'toilet' && { lid: 'closed' as const }),
          ...(app.skirt && { skirt: app.skirt }),
          sizeMm,
          installation: c.installation,
        } as GuideInput,
        { model: 'b0' },
        directions,
      )
    : await renderModelGuides(
        c.model.from === 'trial'
          ? createTrialShape(c.model.shape, sizeMm)
          : createSanitaryShape(
              (c.model as { shape: Parameters<typeof createSanitaryShape>[0] }).shape,
              sizeMm,
            ),
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
