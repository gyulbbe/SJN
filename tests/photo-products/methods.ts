/**
 * What each method of the photo-product trial sends (node, docs/photo-products-20261115.md):
 *   cur  the app's request as it is (P0): a product photo's colour is its pixels' mean (#d5d5d5
 *        "light grey" for a white ceramic photo in shade)
 *   s    the same with each photo product's colour from its catalogue colour name (S)
 *   a    the composite export's request on the scene (experiment A): the room without its fixtures
 *        (behind.ts input-empty.png) and the empty-room prompt; ours go back on top (composite.ts)
 * P (its photo back on the result) works on results: pictures.ts.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildFluxPrompt } from '../../src/lib/ai-export/prompt';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { fluxNeurons } from '../export-photoreal/budget';
import type { PublicRecord, SceneSpec } from '../export-photoreal/scene-builder';
import { pngSize } from '../ledge-ai/methods';
import { SNAPSHOT } from '../tile-ai/paths.mjs';
import { OUT } from './paths.mjs';

export { FLUX_4B, SEEDS } from '../ledge-ai/methods';
export const METHODS = ['cur', 's', 'a'] as const;
export type Method = (typeof METHODS)[number];

/**
 * A catalogue colour name as the colour sent for a photo product (S): white as the standard models'
 * ceramic (reconstruction/types.ts), black and beige as plain glazes.
 */
export const CATALOG_COLORS: Record<string, string> = {
  화이트: '#efefea',
  블랙: '#202020',
  베이지: '#d8c9b0',
};

let records: Map<string, PublicRecord & { materialId: string }> | undefined;
function record(materialId: string) {
  records ??= new Map(
    (
      JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
        placements: (PublicRecord & { materialId: string })[];
      }
    ).placements.map((p) => [p.materialId, p]),
  );
  return records.get(materialId);
}

/** The scene of a scene folder with each photo product's colour from its catalogue colour name. */
export function sScene(dir: string): { scene: FluxScene; changed: string[] } {
  const { scene } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')) as { scene: FluxScene };
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as SceneSpec;
  const changed: string[] = [];
  const fixtures = scene.fixtures.map((fixture) => {
    // One product of each kind in these scenes: the photo product of the fixture's kind.
    const product = (spec.products ?? [])
      .map((p) => record(p.materialId))
      .find((r) => r?.category === fixture.kind);
    const color = product && CATALOG_COLORS[product.color];
    if (!color) return fixture;
    changed.push(`${fixture.kind} ${fixture.color} → ${color} (${product.color})`);
    return { ...fixture, color };
  });
  return { scene: { ...scene, fixtures }, changed };
}

export type FluxRequest = {
  method: Method;
  images: Buffer[];
  prompt: string;
  width: number;
  height: number;
  out: { width: number; height: number };
  estimate: number;
};
/** The FLUX request of one method for a scene folder. */
export function fluxRequest(method: Method, dir: string): FluxRequest {
  const { scene } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')) as { scene: FluxScene };
  const prompt = buildFluxPrompt(
    method === 's'
      ? sScene(dir).scene
      : method === 'a'
        ? { ...scene, fixtures: [], mode: 'empty-room' }
        : scene,
  );
  const image = readFileSync(
    method === 'a' ? join(OUT as string, 'behind', basename(dir), 'input-empty.png') : join(dir, 'input.png'),
  );
  const size = pngSize(image);
  const out = { width: size.width * 2, height: size.height * 2 };
  return { method, images: [image], prompt, ...size, out, estimate: fluxNeurons([size], out) };
}
