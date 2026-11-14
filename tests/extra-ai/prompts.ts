/**
 * Round 0 of the added-objects trial (no AI call): each method's prompt for each scene, its length
 * against the app's limit, and what the added-objects sentence named. Writes prompt-<method>.txt
 * beside each scene's prompt-current.txt.
 *
 * Usage: node tests/run-browser-test.mjs tests/extra-ai/prompts.ts [--holdout]
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUX_PROMPT_MAX_CHARS } from '../../src/lib/ai-export/prompt';
import { fluxRequest, METHODS } from './methods';
import { HOLDOUT, SCENES } from './paths.mjs';

const root = (process.argv.includes('--holdout') ? HOLDOUT : SCENES) as string;
for (const scene of readdirSync(root)) {
  const dir = join(root, scene);
  const lengths: string[] = [];
  for (const method of METHODS) {
    const { prompt } = fluxRequest(method, dir);
    if (prompt.length > FLUX_PROMPT_MAX_CHARS) throw new Error(`${scene} ${method} ${prompt.length}`);
    writeFileSync(join(dir, `prompt-${method}.txt`), prompt);
    const fixtures = prompt.match(/ \d+\. A /g)?.length ?? 0;
    const compact = / No [^.;]* anywhere/.test(prompt);
    const plain = fixtures - (prompt.match(/\(x \d+–\d+%/g)?.length ?? 0);
    lengths.push(
      `${method} ${prompt.length}${compact ? ' compact' : ''} fixtures ${fixtures}${plain ? ` (${plain} without position)` : ''}`,
    );
  }
  console.log(scene.padEnd(10), lengths.join(' | '));
}
