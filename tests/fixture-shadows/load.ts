/**
 * One result of the fixture-haze trial with what the app's finishing steps take (no AI call): the
 * scene, the model's picture with its backdrop back, the render with its fixtures hidden and the
 * cut-outs (copied from tests/fixture-streaks/outline-pictures.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, type RegionMask } from '../../src/lib/ai-export/color';
import type { Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { loadScene, pixels } from '../extra-ai/app-view';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import type { haze } from '../fixture-haze/sources';

const PAD = 0.3;

async function cutsOf(id: string, scene: FluxScene, size: { width: number; height: number }) {
  const cuts: Cut[] = [];
  for (const [k, fixture] of scene.fixtures.entries()) {
    const file = join(HAZE as string, 'cutout', id, `cut-${k}.png`);
    if (!fixture.box || !existsSync(file)) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * size.width)),
      top = Math.max(0, Math.floor((t - bh * PAD) * size.height)),
      right = Math.min(size.width, Math.ceil((r + bw * PAD) * size.width)),
      bottom = Math.min(size.height, Math.ceil((b + bh * PAD) * size.height));
    const alpha = new Uint8Array(
      await sharp(file)
        .ensureAlpha()
        .extractChannel(3)
        .resize(right - left, bottom - top, { fit: 'fill' })
        .raw()
        .toBuffer(),
    );
    cuts.push({ fixture: k, left, top, width: right - left, height: bottom - top, alpha });
  }
  return cuts;
}

/** The refine input of one result, or undefined when the model moved the framing. */
export async function loadInput(source: ReturnType<typeof haze>[number]) {
  if (!existsSync(source.result)) return undefined;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const first = framing(projectCapture(scene.capture, scene.layout, size), result);
  if (!first.aligned) return undefined;
  const layers = join(HAZE as string, 'behind', source.layers);
  const behind = await pixels(join(layers, 'behind.png'));
  const regions = JSON.parse(readFileSync(join(layers, 'regions-behind.json'), 'utf8')) as Omit<
    RegionMask,
    'data'
  >;
  const behindMask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(layers, 'mask-behind.png')).extractChannel(0).raw().toBuffer()),
  };
  const checked =
    (scene.mask.outside
      ? restoreBackdrop({
          result,
          capture: scene.capture,
          mask: scene.mask,
          layout: scene.layout,
          shift: first,
        })
      : undefined) ?? result;
  return {
    scene,
    input: {
      raw: checked,
      capture: scene.capture,
      mask: scene.mask,
      layout: scene.layout,
      joints: scene.joints,
      fixtures: scene.scene.fixtures,
      behind: { image: behind, mask: behindMask },
      cuts: await cutsOf(source.id, scene.scene, size),
    },
  };
}
