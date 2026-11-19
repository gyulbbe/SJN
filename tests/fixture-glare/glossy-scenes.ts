/**
 * Which trial scenes have glossy or polished tiles in today's app prompt (no AI call).
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/glossy-scenes.ts
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze } from '../fixture-haze/sources';
import { fluxRequest } from '../photo-products/methods';

const dirs = new Map<string, string>();
for (const group of ['new', 'reg', 'bath'])
  if (existsSync(join(HAZE as string, group, 'scenes')))
    for (const scene of readdirSync(join(HAZE as string, group, 'scenes')))
      dirs.set(`${group}/${scene}`, join(HAZE as string, group, 'scenes', scene));
for (const set of ['dev', 'holdout'] as const) for (const s of haze(set)) dirs.set(`${set}/${s.scene}`, s.dir);
for (const [name, dir] of dirs) {
  const prompt = fluxRequest('cur', dir).prompt;
  const tiles = [...prompt.matchAll(/([A-Z][a-z ]+(?:wall|floor)[a-z ]*): ([a-z -]+(?: \(#[0-9a-f]{6}\))?) (glossy|polished|semi-gloss) tiles/g)].map((m) => `${m[1]}: ${m[2]} ${m[3]}`);
  if (tiles.length) console.log(name.padEnd(22), prompt.length, tiles.join(' | '));
}
