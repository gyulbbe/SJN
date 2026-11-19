/**
 * The app's prompt (prompt.ts) for every trial scene with the ceramic sentence (no AI call): its length
 * and whether the added-objects sentence went compact or fixture details were dropped to fit.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/prompt-lengths.ts
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FLUX_CHINA_SENTENCE } from '../../src/lib/ai-export/prompt';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze } from '../fixture-haze/sources';
import { fluxRequest } from '../photo-products/methods';

const dirs = new Map<string, string>();
for (const group of ['new', 'reg', 'bath'])
  if (existsSync(join(HAZE as string, group, 'scenes')))
    for (const scene of readdirSync(join(HAZE as string, group, 'scenes')))
      dirs.set(`${group}/${scene}`, join(HAZE as string, group, 'scenes', scene));
for (const set of ['dev', 'holdout'] as const)
  for (const s of haze(set)) dirs.set(`${set}/${s.scene}`, s.dir);
for (const [name, dir] of dirs) {
  let prompt: string;
  try {
    prompt = fluxRequest('cur', dir).prompt;
  } catch (e) {
    console.log(name.padEnd(28), 'no request', e instanceof Error ? e.message.slice(0, 60) : '');
    continue;
  }
  const china = prompt.split(FLUX_CHINA_SENTENCE).length - 1;
  const compact = !prompt.includes('These objects are not in this design');
  const dropped = !/\(x \d+–\d+%/.test(prompt.slice(prompt.lastIndexOf(' A '))) ? 'last fixture short' : '';
  console.log(
    name.padEnd(28),
    prompt.length,
    `china ${china}`,
    compact ? 'compact added-objects' : '',
    dropped,
  );
}
