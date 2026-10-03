import { z } from 'zod';
import { colorWords, FLUX_KIND_NOUNS } from './prompt';
import {
  FLUX_FACINGS,
  FLUX_FINISHES,
  FLUX_FIXTURE_FORMS,
  FLUX_FIXTURE_KINDS,
  fluxHex,
  fluxMm,
  type FluxFacing,
} from './scene-contract';

/**
 * The per-product refinement: one product at a time, cut out of the room render and drawn large on a
 * plain white background, is sent to FLUX.2 klein to be redrawn as a studio photograph (see
 * docs/flux-export.md). What the editor knows about the product travels as enums, numbers and a
 * colour only, as in the room scene (scene-contract.ts); the server writes every sentence.
 */
export const fluxProductSchema = z.strictObject({
  kind: z.enum(FLUX_FIXTURE_KINDS),
  forms: z.array(z.enum(FLUX_FIXTURE_FORMS)).max(4),
  color: fluxHex,
  finish: z.enum(FLUX_FINISHES),
  /** Which way the product points in the crop, as seen by the camera (not the room's walls). */
  facing: z.enum(FLUX_FACINGS).optional(),
  /** Width × height × depth. */
  sizeMm: z.tuple([fluxMm, fluxMm, fluxMm]),
});
export type FluxProduct = z.infer<typeof fluxProductSchema>;

/**
 * Image 0 is the crop (our render). With a reference, image 1 is the real product's photo: it may
 * say what the colours, markings and small details are, never the shape, size or viewing angle.
 */
export const FLUX_PRODUCT_PROMPT =
  'Image 0 is a render of this exact product. Make it a photorealistic studio photograph of the same product: keep the shape, proportions, viewing angle, size and position in the frame exactly; keep the plain white background; only improve materials, glaze, edges and small details.';
export const FLUX_PRODUCT_REFERENCE_SENTENCE =
  'Image 1 shows the real product: use it for colours, markings and small details only, never for the shape, the viewing angle or the position, which stay exactly as in image 0.';
export const FLUX_PRODUCT_KEEP_SENTENCE =
  'Add no other object, no floor, no cast shadow, no text and no label; do not add, remove or replace any part of the product.';

/** Where the product points in the picture, said from the camera's side. */
export function productFacingPhrase(facing: FluxFacing): string {
  return {
    front: 'towards the camera',
    right: 'to the right of the picture',
    left: 'to the left of the picture',
    back: 'away from the camera',
  }[facing];
}

/** Deterministic: the same product and the same choice of a reference always give the same text. */
export function buildFluxProductPrompt(product: FluxProduct, withReference: boolean): string {
  const noun = FLUX_KIND_NOUNS[product.kind];
  const forms = product.forms.length ? `${product.forms.join(', ')} ` : '';
  const size = product.sizeMm.map((value) => Math.round(value)).join(' × ');
  const facing = product.facing ? `, pointing ${productFacingPhrase(product.facing)}` : '';
  return [
    FLUX_PRODUCT_PROMPT,
    withReference ? FLUX_PRODUCT_REFERENCE_SENTENCE : '',
    `The product is a ${colorWords(product.color)} ${product.finish} ${forms}${noun}, about ${size} mm (W × H × D)${facing}. It must remain this ${noun}.`,
    FLUX_PRODUCT_KEEP_SENTENCE,
  ]
    .filter(Boolean)
    .join(' ');
}
