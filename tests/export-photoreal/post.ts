/**
 * What the app would show for each result (no AI call unless --check): the same steps in the same
 * order as the export dialog (src/components/editor/ai-export.tsx), with the app's own functions:
 * the white backdrop back where the model kept the framing (restoreBackdrop), then either the faces'
 * colours back to the render's (reviewResultColors) or, for experiments A and B, our fixtures on the
 * model's room (composeFluxResult). The corrected picture is what the dialog shows first.
 *
 * --check also asks Gemma once per result, as the app does after a conversion (fluxCheckScene,
 * fluxCheckPayload, readFluxCheckCompletion, readFluxCheck): the backdrop-restored result as a JPEG
 * (quality 0.9, at most 1024 px). That is a real call (about 12 neurons) through ai.ts.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/post.ts [--methods a,b] [--check --round r2] [--holdout]
 * Output: results/<method>/<scene>-<seed>.app.png, .post.json, .check.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { fluxCheckPayload, readFluxCheckCompletion } from '../../src/lib/ai-export/check-server';
import type { FluxCheckWall } from '../../src/lib/ai-export/check-contract';
import { fluxCheckScene } from '../../src/lib/ai-export/client';
import { framing, projectCapture, reviewResultColors, type Pixels } from '../../src/lib/ai-export/color';
import { composeFluxResult, placeholderRoom } from '../../src/lib/ai-export/composite';
import { fluxInputLayout } from '../../src/lib/ai-export/contract';
import { readFluxCheck } from '../../src/lib/ai-export/notices';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { jsonCall, StopRun } from './ai';
import { loadScene, loadTyped, readPng, sceneDir, writePng } from './io';
import { RESULTS } from './paths.mjs';
import type { RegionMask } from '../../src/lib/ai-export/color';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes('--check');
const round = arg('round') ?? 'post';
const only = arg('methods')?.split(',');
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const COMPOSITE = new Set(['empty', 'placeholders']);

/** The model's answer at the size the app would read it (a 768 px input's answer is brought to 2 × 496). */
async function answer(file: string, layout: { width: number; height: number }): Promise<Pixels> {
  const meta = await sharp(file).metadata();
  const want = { width: layout.width * 2, height: layout.height * 2 };
  if (meta.width === want.width && meta.height === want.height) return readPng(file);
  return readPng(await sharp(file).resize(want.width, want.height, { fit: 'fill' }).png().toBuffer());
}

for (const method of readdirSync(RESULTS as string)) {
  if (only && !only.includes(method)) continue;
  if (method === 'refine' || method === 'none') continue;
  const folder = join(RESULTS as string, method);
  for (const file of readdirSync(folder).filter((f) => /^[a-z]+-\d+\.png$/.test(f))) {
    const [scene, seed] = file.replace('.png', '').split('-');
    let dir: string;
    try {
      dir = sceneDir(scene);
    } catch {
      continue; // a held-out scene without --holdout
    }
    const base = join(folder, `${scene}-${seed}`);
    const inRoom = method === 'inroom';
    const payload = inRoom ? undefined : await loadScene(scene);
    const capture = inRoom ? await readPng(join(dir, 'inroom', 'capture.png')) : payload!.capture;
    const mask = inRoom ? loadTyped<RegionMask>(join(dir, 'inroom'), 'mask') : payload!.mask;
    const layout = fluxInputLayout(capture.width, capture.height);
    const grounding = JSON.parse(
      readFileSync(join(dir, inRoom ? 'inroom' : '', 'grounding.json'), 'utf8'),
    ) as {
      scene: FluxScene;
    };
    const { boxes, walls } = JSON.parse(
      readFileSync(join(dir, inRoom ? 'inroom' : '', 'boxes.json'), 'utf8'),
    ) as {
      boxes: Record<string, [number, number, number, number]>;
      walls: FluxCheckWall[];
    };
    const composite = COMPOSITE.has(method);
    const layers = payload?.layers;
    // What the model was sent, at capture size: the composite sends the room without fixtures.
    const sent: Pixels =
      composite && layers
        ? method === 'placeholders'
          ? placeholderRoom(layers)
          : { width: layers.width, height: layers.height, data: layers.empty }
        : capture;
    let result = await answer(`${base}.png`, layout);
    const frame = framing(projectCapture(sent, layout, result), result);
    const restored =
      mask.outside && frame.aligned
        ? restoreBackdrop({ result, capture: sent, mask, layout, shift: frame })
        : undefined;
    if (restored) result = restored;
    const post: Record<string, unknown> = {
      framing: frame,
      backdropRestored: !!restored,
      marginKept: !!mask.outside && !frame.aligned,
    };
    if (composite && layers) {
      const composed = composeFluxResult({
        result,
        input: sent,
        layers,
        mask,
        layout,
        boxes: Object.values(boxes),
      });
      await writePng(`${base}.app.png`, composed.corrected ?? composed.raw);
      Object.assign(post, {
        shown: composed.corrected ? 'corrected' : 'raw',
        shifted: composed.shifted,
        floor: composed.floor,
        aligned: composed.review.framing.aligned,
        changes: composed.review.changes,
        warnings: composed.review.warnings.length,
        unmatched: composed.review.unmatched.length,
      });
    } else {
      const review = reviewResultColors({ capture, mask, layout, result });
      await writePng(`${base}.app.png`, review.corrected ?? result);
      Object.assign(post, {
        shown: review.corrected ? 'corrected' : review.framing.aligned ? 'restored' : 'reframed',
        aligned: review.framing.aligned,
        changes: review.changes,
        residual: review.residual,
        warnings: review.warnings.length,
        unmatched: review.unmatched.length,
      });
    }
    await writePng(`${base}.restored.png`, result);
    writeFileSync(`${base}.post.json`, JSON.stringify(post, null, 1));
    if (!check || existsSync(`${base}.check.json`)) continue;
    const checkScene = fluxCheckScene(
      grounding.scene,
      walls,
      composite ? (method === 'placeholders' ? 'placeholders' : 'empty') : undefined,
    );
    if (!checkScene) continue;
    const jpeg = await sharp(
      Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
      {
        raw: { width: result.width, height: result.height, channels: 4 },
      },
    )
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    try {
      const { result: completion } = await jsonCall(
        { round, method: `check:${method}`, scene, seed: Number(seed), model: GEMMA, estimate: 13 },
        fluxCheckPayload(checkScene, { bytes: new Uint8Array(jpeg), mime: 'image/jpeg' }),
      );
      const parsed = readFluxCheckCompletion(completion, checkScene);
      const reading = readFluxCheck(parsed, checkScene.fixtures, { emptyRoom: composite });
      writeFileSync(`${base}.check.json`, JSON.stringify({ scene: checkScene, parsed, reading }, null, 1));
      console.log('checked', method, scene, seed);
    } catch (error) {
      if (error instanceof StopRun) {
        console.error('STOP', error.message);
        process.exit(2);
      }
      writeFileSync(`${base}.check.json`, JSON.stringify({ error: String(error) }, null, 1));
    }
  }
}
