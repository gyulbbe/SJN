/**
 * A result of the added-objects trial as the export dialog shows it (src/components/editor/ai-export.tsx),
 * with the app's own functions in the app's order: the plain backdrop back where the model kept the
 * framing (what the Gemma check is sent), then the joints back on the faces whose joints drifted, then
 * the faces' colours back to the render's. O3 (erase.ts) goes in after the joints when asked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import type { FluxCheckScene } from '../../src/lib/ai-export/check-contract';
import {
  framing,
  projectCapture,
  projectMask,
  reviewResultColors,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { restoreResultJoints } from '../../src/lib/ai-export/joints';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { eraseAdded, type EraseCriteria, type EraseResult } from './erase';

export const pixels = async (file: string | Buffer): Promise<Pixels> => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};
export const png = (image: Pixels) =>
  sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .removeAlpha()
    .png()
    .toBuffer();

export type TrialScene = {
  dir: string;
  layout: FluxInputLayout;
  mask: RegionMask;
  capture: Pixels;
  joints: Pixels;
  scene: FluxScene;
  check: FluxCheckScene | null;
  azimuth: number;
};
/** A scene folder of this trial (scenes.ts); `jointsFile` reads an older trial's (tile AI: capture-grout.png). */
export async function loadScene(dir: string, jointsFile = 'joints.png'): Promise<TrialScene> {
  const json = <T>(name: string, fallback?: T) =>
    fallback !== undefined && !existsSync(join(dir, name))
      ? fallback
      : (JSON.parse(readFileSync(join(dir, name), 'utf8')) as T);
  const regions = json<Omit<RegionMask, 'data'>>('regions.json');
  const channel = async (name: string) =>
    new Uint8Array(await sharp(join(dir, name)).extractChannel(0).raw().toBuffer());
  return {
    dir,
    layout: json<{ layout: FluxInputLayout }>('layout.json').layout,
    mask: { ...regions, data: await channel('mask.png'), outside: await channel('mask-outside.png') },
    capture: await pixels(join(dir, 'capture.png')),
    joints: await pixels(join(dir, jointsFile)),
    scene: json<{ scene: FluxScene }>('grounding.json').scene,
    check: json<FluxCheckScene | null>('check-scene.json', null),
    azimuth: json<{ azimuth?: number }>('spec.json', {}).azimuth ?? 0,
  };
}

/** Face labels (1-based) that a picture-relative place names, by where each face sits in the frame. */
export function facesAt(mask: RegionMask, places: readonly string[]): Set<number> {
  const sums = new Map<number, { x: number; n: number }>();
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      const label = mask.data[y * mask.width + x];
      if (!label || label > mask.regions.length) continue;
      const entry = sums.get(label) ?? { x: 0, n: 0 };
      entry.x += x;
      entry.n++;
      sums.set(label, entry);
    }
  const out = new Set<number>();
  for (const [label, { x, n }] of sums) {
    const kind = mask.regions[label - 1].kind;
    const centre = x / n / mask.width;
    const side = centre < 0.4 ? 'left' : centre > 0.6 ? 'right' : 'back';
    const named =
      places.includes('middle') ||
      (kind === 'floor' && places.includes('floor')) ||
      (kind === 'wall' && places.includes(side));
    if (named) out.add(label);
  }
  return out;
}

export type AppView = {
  /** The model's picture with the backdrop back (what the app checks and keeps as the AI original). */
  checked: Pixels;
  /** What the dialog shows first. */
  shown: Pixels;
  aligned: boolean;
  joints: string[];
  coloured: boolean;
  erased?: EraseResult;
};
export function appView(
  scene: TrialScene,
  result: Pixels,
  erase?: { labels?: ReadonlySet<number>; criteria?: EraseCriteria },
  /** The tile-pattern trial's rule: restore faces under this joint score (Infinity: every face). */
  restoreBelow?: number,
): AppView {
  const { capture, mask, layout } = scene;
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(capture, layout, size);
  const frame = framing(reference, result);
  const checked =
    (frame.aligned && mask.outside
      ? restoreBackdrop({ result, capture, mask, layout, shift: frame })
      : undefined) ?? result;
  if (!frame.aligned) return { checked, shown: checked, aligned: false, joints: [], coloured: false };
  // The app measures the framing again on the backdrop-restored picture before the joints.
  const again = framing(reference, checked);
  const joints = again.aligned
    ? restoreResultJoints({
        capture,
        joints: scene.joints,
        mask,
        layout,
        result: checked,
        frame: again,
        restoreBelow,
      })
    : undefined;
  // O3 after the joints: on a face whose joints were put back the model's moved joints are gone, so
  // only what it added is left to find.
  const erased =
    erase && again.aligned
      ? eraseAdded(
          reference,
          joints?.image ?? checked,
          shiftMask(projectMask(mask, layout, size), again.dx, again.dy),
          { shift: again, labels: erase.labels, criteria: erase.criteria },
        )
      : undefined;
  const onto = erased?.image ?? joints?.image ?? checked;
  const review = reviewResultColors({
    capture,
    mask,
    layout,
    result: onto,
    ...(onto !== checked ? { alignment: { dx: again.dx, dy: again.dy } } : {}),
  });
  return {
    checked,
    // A colour check that loses the framing shows the model's picture, as the dialog does.
    shown: review.framing.aligned ? (review.corrected ?? onto) : checked,
    aligned: review.framing.aligned,
    joints: joints?.restored.map((face) => face.key) ?? [],
    coloured: !!review.corrected,
    erased,
  };
}
