/**
 * The app's prompt now (prompt.ts, contract.ts) against the prompt the trial sent as `diffsemi`
 * (run-glare2.ts, run-glare3.ts), scene by scene (no AI call).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/app-prompt-check.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze } from '../fixture-haze/sources';
import { fluxRequest } from '../photo-products/methods';
import { OUT } from './paths.mjs';

let same = 0,
  differ = 0;
for (const group of readdirSync(join(OUT as string, 'ai'))) {
  for (const file of readdirSync(join(OUT as string, 'ai', group)).filter((f) =>
    f.endsWith('.diffsemi.json'),
  )) {
    const sent = JSON.parse(readFileSync(join(OUT as string, 'ai', group, file), 'utf8')) as {
      scene: string;
      seed: number;
      prompt: string;
    };
    const dir =
      group === 'dev' || group === 'holdout'
        ? haze(group).find((s) => s.scene === sent.scene && s.seed === sent.seed)!.dir
        : join(HAZE as string, group, 'scenes', sent.scene);
    if (!existsSync(dir)) continue;
    const app = fluxRequest('cur', dir).prompt;
    if (app === sent.prompt) {
      same++;
      console.log(`${group}/${sent.scene}`.padEnd(24), 'same', app.length);
    } else {
      differ++;
      let k = 0;
      while (k < app.length && app[k] === sent.prompt[k]) k++;
      console.log(
        `${group}/${sent.scene}`.padEnd(24),
        'DIFFER',
        app.length,
        sent.prompt.length,
        '| app:',
        app.slice(k - 20, k + 60),
        '| sent:',
        sent.prompt.slice(k - 20, k + 60),
      );
    }
  }
}
console.log(`same ${same}, differ ${differ}`);
