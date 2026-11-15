/**
 * Checks that the app's own code (joints.ts RESTORE_LIGHT_KEEP, no trial option) draws the trial's
 * chosen pictures (k25) pixel for pixel, on the development and holdout results. No AI call.
 *
 * Usage: node tests/run-browser-test.mjs tests/ai-light/app-check.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { framing, projectCapture } from '../../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { appView, loadScene, pixels } from '../extra-ai/app-view';
import { sources } from '../tile-pattern/sources';
import { OUT } from './paths.mjs';

let same = 0;
const differ: string[] = [];
for (const set of ['dev', 'holdout'] as const)
  for (const source of sources(set)) {
    const chosen = join(OUT as string, 'pictures', `${source.id}.k25.png`);
    if (!existsSync(source.result) || !existsSync(chosen)) continue;
    const scene = await loadScene(source.dir, source.jointsFile);
    const result = await pixels(source.result);
    const view = appView(scene, result);
    if (!view.aligned) continue;
    const reference = projectCapture(scene.capture, scene.layout, {
      width: result.width,
      height: result.height,
    });
    const frame = framing(reference, view.checked);
    const shown =
      restoreFixtureLightness({
        capture: scene.capture,
        mask: scene.mask,
        layout: scene.layout,
        fixtures: scene.scene.fixtures,
        result: view.shown,
        frame,
      }).image ?? view.shown;
    const expected = await pixels(chosen);
    let most = 0;
    for (let i = 0; i < shown.data.length; i++)
      most = Math.max(most, Math.abs(shown.data[i] - expected.data[i]));
    if (most === 0) same++;
    else differ.push(`${source.id} (${most})`);
  }
console.log(`app = trial k25: ${same} same, ${differ.length} differ ${differ.join(', ')}`);
if (differ.length) process.exit(1);
