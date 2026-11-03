/**
 * Round 9 (③ 조각 점검): one Gemma call a photo (photos go to Cloudflare). Two images: the photo with
 * each face's piece after ② outlined and numbered, and the pieces themselves under the same numbers.
 * Gemma says, per piece, what fills it, how much tile shows, the tile's state, what its marks are and
 * how sure it is (`INSPECT_TEXT`, the same words for every photo, no answer in them). Every call goes
 * through `callAi` (ledger, 90% refusal, a daily limit stops the run); a photo already answered is
 * skipped, so a stopped run goes on where it stopped.
 *
 * Needs the temporary Worker (see ai-worker/worker.ts).
 * `--pieces now` asks the same about today's pieces (round 1's clean part), for the case without ②.
 * `--split heldout` (round 7) asks it about the held-out photos' pieces (today's way, as adopted).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r9-inspect.ts [--pieces r9|now] [--split heldout] [--limit N] [--dry]
 * Output: test-results/catalog-match/r9-inspect/{answers.jsonl,answers-now.jsonl,answers-heldout.jsonl,boards/}
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACCOUNT_DAILY, BUDGET, callAi, spent, StopRun } from './ai';
import { out, readJson } from './data';
import { gemmaImages, INSPECT_TEXT, inspectSchema } from './questions';
import type { Quad } from './tile-features';
import { openHarness } from './browser/harness';
import type * as Page from './browser/page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit', '0'));
const PIECES = arg('pieces', 'r9');
if (!['r9', 'now'].includes(PIECES)) throw new Error('--pieces r9|now');
const HELDOUT = arg('split', '') === 'heldout';
if (HELDOUT && PIECES !== 'now') throw new Error('--split heldout needs --pieces now');
const NAME = HELDOUT ? 'heldout' : PIECES;
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
/** Two images (about 370 input tokens each) and four pieces of JSON: a little over round 4's 6. */
const COST = 10;
const target = join(out, 'r9-inspect');
mkdirSync(join(target, 'boards'), { recursive: true });
const answersFile = join(
  target,
  { r9: 'answers.jsonl', now: 'answers-now.jsonl', heldout: 'answers-heldout.jsonl' }[NAME]!,
);

type Face = {
  id: string;
  photo: string;
  path: string;
  split: string;
  face: string;
  regions: { clean?: { quad: Quad } };
};
const faces = readJson<Face[]>(
  join(
    out,
    'features',
    { r9: 'queries-photos-r9', now: 'queries-photos-q8', heldout: 'queries-heldout-q8' }[NAME]!,
    'faces.json',
  ),
);
const photos = [...new Set(faces.map((f) => f.photo))].map((photo) => {
  const own = faces.filter((f) => f.photo === photo && f.regions.clean);
  return {
    photo,
    path: own[0]?.path,
    faces: own.map((f) => f.face),
    quads: own.map((f) => f.regions.clean!.quad),
    crops: own.map((f) =>
      join(
        out,
        'crops',
        { r9: 'r9', now: 'photos', heldout: 'heldout' }[NAME]!,
        `${f.id.replace(':', '-')}.jpg`,
      ),
    ),
  };
});
const answered = new Set(
  existsSync(answersFile)
    ? readFileSync(answersFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { photo: string }).photo)
    : [],
);
const pending = photos.filter((p) => p.faces.length && !answered.has(p.photo));
const list = LIMIT ? pending.slice(0, LIMIT) : pending;
const left = Math.min(BUDGET * 0.9 - spent(), ACCOUNT_DAILY);
console.log(
  `inspect: ${list.length} photos × gemma ≈ ${list.length * COST} neurons; spent so far ~${Math.round(spent())}`,
);
if (!DRY && list.length * COST > left)
  throw new Error(`expected ${list.length * COST} > what is left (${Math.round(left)})`);

const harness = await openHarness({ pageEntry: resolve('tests/catalog-match/browser/page.ts'), gpu: true });
try {
  const { page } = harness;
  for (const p of list) {
    const images = await page.evaluate(
      async ({ path, quads, crops }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const bitmap = await CM.loadBitmap(path);
        const outlined = CM.outlinedPhoto(bitmap, quads as Quad[]);
        bitmap.close();
        const pieces: HTMLCanvasElement[] = [];
        for (const crop of crops) {
          const b = await CM.loadBitmap(crop);
          const canvas = CM.canvasOf(b.width, b.height);
          canvas.getContext('2d')!.drawImage(b, 0, 0);
          b.close();
          pieces.push(canvas);
        }
        return [CM.dataUrlOf(outlined), CM.dataUrlOf(CM.piecesBoard(pieces))];
      },
      { path: p.path, quads: p.quads, crops: p.crops },
    );
    images.forEach((url, i) =>
      writeFileSync(
        join(target, 'boards', `${NAME}-${p.photo}-${i + 1}.jpg`),
        Buffer.from(url.split(',')[1], 'base64'),
      ),
    );
    if (DRY) continue;
    try {
      const { result, neurons, ms } = await callAi({
        round: HELDOUT ? 'r7' : 'r9',
        task: { r9: 'inspect', now: 'inspect-now', heldout: 'inspect-heldout' }[NAME]!,
        photo: p.photo,
        model: MODEL,
        input: {
          ...gemmaImages(INSPECT_TEXT + ' Reply as JSON.', images, inspectSchema(p.faces.length)),
          max_completion_tokens: 800,
        },
        estimate: COST * 1.5,
      });
      appendFileSync(
        answersFile,
        JSON.stringify({
          at: new Date().toISOString(),
          photo: p.photo,
          faces: p.faces,
          neurons,
          ms,
          result,
        }) + '\n',
      );
    } catch (error) {
      if (error instanceof StopRun && !/stopped|refused \(/.test(error.message)) throw error;
      console.error(p.photo, error instanceof Error ? error.message : error);
    }
    process.stdout.write(`\rinspect ${list.indexOf(p) + 1}/${list.length} (~${Math.round(spent())} neurons)`);
  }
} catch (error) {
  if (!(error instanceof StopRun)) throw error;
  console.error('\nSTOPPED:', error.message);
} finally {
  console.log(`\nledger: ~${Math.round(spent())} neurons`);
  await harness.close();
}
