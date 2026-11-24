// Backlog item 5, step 29: today's app captures of the olive scenes (capture.ts --rev app, after
// 32269f8) against the Cloudflare answers already saved for the same scene and seed. The app's prompt is
// today's candidate ("olive"); the prompt main sent before is the same text with the olive sentence put
// back (prepare.mjs SENTENCES.cur). A saved answer is reused only when its input and prompt hashes equal
// today's input and that main prompt.
//   node tests/olive-name/reuse.mjs
// Output: test-results/olive-name-cf-20261124/{cur,n2}/scenes/<scene>/ and a table on stdout
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { SENTENCES } from './prepare.mjs';

export const CF_OUT = join(ROOT, 'test-results', 'olive-name-cf-20261124');
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const SAVED = {
  'olive-0': join(ROOT, 'test-results', 'room-depth-20261123', 'cf', 'app', 'raw'),
  'olive-90': join(ROOT, 'test-results', 'room-depth-20261123', 'cf', 'app', 'raw'),
  'bath-olive-0': join(ROOT, 'test-results', 'big-fixture-20261124', 'cf', 'app', 'raw'),
};
const swap = (text, [fromWords, fromKeep], [toWords, toKeep]) => {
  const at = text.indexOf(fromWords);
  const keepAt = text.indexOf(fromKeep, at);
  if (at < 0 || keepAt < 0 || text.indexOf(fromWords, at + 1) >= 0)
    throw new Error('olive sentence not there once');
  return (
    text.slice(0, at) +
    toWords +
    text.slice(at + fromWords.length, keepAt) +
    toKeep +
    text.slice(keepAt + fromKeep.length)
  );
};
const main = import.meta.url === pathToFileURL(process.argv[1]).href;
for (const scene of main ? ['olive-0', 'olive-90', 'bath-olive-0', 'bath-olive-90'] : []) {
  const app = join(CF_OUT, 'app', 'scenes', scene);
  const appPrompt = readFileSync(join(app, 'prompt.txt'), 'utf8');
  const input = readFileSync(join(app, 'input.png'));
  // The app's prompt must be the step-27 "olive" text exactly (n2).
  const main = swap(appPrompt, SENTENCES.n2, SENTENCES.cur);
  if (swap(main, SENTENCES.cur, SENTENCES.n2) !== appPrompt) throw new Error(`${scene}: swap not exact`);
  for (const [rev, prompt] of [
    ['cur', main],
    ['n2', appPrompt],
  ]) {
    const to = join(CF_OUT, rev, 'scenes', scene);
    if (!existsSync(to)) {
      mkdirSync(to, { recursive: true });
      cpSync(app, to, { recursive: true });
    }
    writeFileSync(join(to, 'prompt.txt'), prompt);
  }
  const saved = SAVED[scene] && join(SAVED[scene], `${scene}-424242.json`);
  let reuse = 'none saved';
  if (saved && existsSync(saved)) {
    const j = JSON.parse(readFileSync(saved, 'utf8'));
    const same = j.input === sha(input) && j.prompt === sha(main);
    reuse = `saved input ${j.input === sha(input) ? '=' : '≠'} prompt ${j.prompt === sha(main) ? '=' : '≠'}`;
    if (same) {
      const raw = join(CF_OUT, 'cur', 'raw');
      mkdirSync(raw, { recursive: true });
      for (const ext of ['png', 'json'])
        cpSync(saved.replace(/\.json$/, `.${ext}`), join(raw, `${scene}-424242.${ext}`));
      reuse += ' → reused';
    }
  }
  console.log(scene.padEnd(14), 'input', sha(input), 'main prompt', sha(main), reuse);
}
