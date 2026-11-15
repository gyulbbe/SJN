/**
 * The niche-look trial's AI results as the app shows them (no AI call, docs/niche-look-20261115.md):
 * the backdrop, the joints on every tiled face, the wall and floor colours (tests/extra-ai/app-view.ts)
 * and the white ceramics' lightness (fixture-light.ts), in the app's order.
 *
 * Usage: node tests/run-browser-test.mjs tests/niche-look/pictures.ts
 * Output: test-results/niche-look-20261115/pictures/<variant>-<scene>-<seed>.{raw,app}.png
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { framing, projectCapture } from '../../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT } from './paths.mjs';

const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
for (const variant of ['cur', 'h3s'])
  for (const scene of ['structure', 'niche-only', 'busy'])
    for (const seed of [424242, 777001]) {
      const file = join(OUT as string, 'results', 'cf', variant, `${scene}-${seed}.png`);
      if (!existsSync(file)) continue;
      const parts = await loadScene(join(OUT as string, 'scenes', variant, scene));
      const result = await pixels(file);
      const view = appView(parts, result);
      let shown = view.shown;
      if (view.aligned) {
        const size = { width: result.width, height: result.height };
        const frame = framing(projectCapture(parts.capture, parts.layout, size), view.checked);
        shown =
          restoreFixtureLightness({
            capture: parts.capture,
            mask: parts.mask,
            layout: parts.layout,
            fixtures: parts.scene.fixtures,
            result: view.shown,
            frame,
          }).image ?? view.shown;
      }
      const id = `${variant}-${scene}-${seed}`;
      writeFileSync(join(dir, `${id}.raw.png`), await png(view.checked));
      writeFileSync(join(dir, `${id}.app.png`), await png(shown));
      console.log(id, view.aligned ? `joints ${view.joints.length}` : 'not aligned');
    }
