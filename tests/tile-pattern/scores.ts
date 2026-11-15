/**
 * Step 0 of the tile-pattern trial (no AI call, docs/tile-pattern-trials-20261115.md): every wall and
 * floor of every picture with its joint score (what the app restores on today, under 0.3) and its
 * pattern score (pattern.ts), next to what the user wrote about that picture as the app showed it then
 * (tile trial: `cur+restore` in review t4/t5; added-objects trial: `names-end` in r2/u12/r2u/r4).
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-pattern/scores.ts [--holdout]
 * Output: the table on the console and test-results/tile-pattern-20261115/scores-<dev|holdout>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, projectMask } from '../../src/lib/ai-export/color';
import { faceScores, RESTORE_BELOW } from '../../src/lib/ai-export/joints';
import { loadScene, pixels, type TrialScene } from '../extra-ai/app-view';
import { patternScores } from './pattern';
import { EXTRA, OUT, TILE } from './paths.mjs';
import { sources, type Source } from './sources';

const set = process.argv.includes('--holdout') ? 'holdout' : 'dev';

type Note = { flags: string[]; note: string; real: number; design: number };
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Note & { id: string })
    : [];
/** What the user said about each picture as the app showed it then (the last rating counts). */
function userNotes(): Map<string, Note> {
  const out = new Map<string, Note>();
  for (const name of ['t4', 't5']) {
    const dir = join(TILE as string, 'review', name);
    if (!existsSync(join(dir, 'key.json'))) continue;
    const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')).singles as Record<
      string,
      { method: string; scene: string; seed: number }
    >;
    for (const row of lines(join(dir, 'ratings.jsonl'))) {
      const job = key[row.id];
      if (job?.method === 'cur+restore') out.set(`t-${job.scene}-${job.seed}`, row);
    }
  }
  const review = join(EXTRA as string, 'review');
  const r2 = JSON.parse(readFileSync(join(review, 'r2', 'key.json'), 'utf8')).singles as Record<
    string,
    { jobs: { method: string; scene: string; seed: number }[] }
  >;
  for (const name of ['u12', 'r2u']) {
    const key = JSON.parse(readFileSync(join(review, name, 'key.json'), 'utf8')).singles as Record<
      string,
      { from: string }
    >;
    for (const row of lines(join(review, name, 'ratings.jsonl')))
      for (const job of r2[key[row.id].from].jobs)
        if (job.method === 'names-end') out.set(`x-${job.scene}-${job.seed}`, row);
  }
  const r4 = join(review, 'r4');
  if (existsSync(join(r4, 'key.json'))) {
    const key = JSON.parse(readFileSync(join(r4, 'key.json'), 'utf8')).singles as Record<
      string,
      { jobs: { method: string; scene: string; seed: number }[] }
    >;
    for (const row of lines(join(r4, 'ratings.jsonl')))
      for (const job of key[row.id].jobs)
        if (job.method === 'names-end') out.set(`x-${job.scene}-${job.seed}`, row);
  }
  return out;
}

export type FaceRow = {
  key: string;
  kind: string;
  joint: number | null;
  pattern: number | null;
  ratio: number | null;
  detail: number | null;
  amount: number | null;
  amount75: number | null;
  restoredNow: boolean;
};
export type PictureRow = { id: string; aligned: boolean; ms: number; faces: FaceRow[]; user?: Note };

/** One picture's faces as the app sees them (backdrop back, framing measured again). */
export async function measure(source: Source, scene: TrialScene): Promise<PictureRow> {
  const result = await pixels(source.result);
  const { capture, joints, mask, layout } = scene;
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(capture, layout, size);
  const frame = framing(reference, result);
  const checked =
    (frame.aligned && mask.outside
      ? restoreBackdrop({ result, capture, mask, layout, shift: frame })
      : undefined) ?? result;
  const again = frame.aligned ? framing(reference, checked) : frame;
  if (!again.aligned) return { id: source.id, aligned: false, ms: 0, faces: [] };
  const projected = projectMask(mask, layout, size);
  const widened = projectCapture(joints, layout, size);
  const jointScores = faceScores(widened, checked, projected, again.dx, again.dy);
  const started = performance.now();
  const patterns = patternScores(reference, widened, checked, projected, again.dx, again.dy);
  const ms = performance.now() - started;
  const faces = mask.regions.flatMap((region): FaceRow[] => {
    const j = jointScores.find((s) => s.key === region.key),
      p = patterns.find((s) => s.key === region.key);
    if (!j && !p) return [];
    return [
      {
        key: region.key,
        kind: region.kind,
        joint: j?.score ?? null,
        pattern: p?.score ?? null,
        ratio: p?.ratio ?? null,
        detail: p?.detail ?? null,
        amount: p?.amount ?? null,
        amount75: p?.amount75 ?? null,
        restoredNow: !!j && j.score < RESTORE_BELOW,
      },
    ];
  });
  return { id: source.id, aligned: true, ms: Math.round(ms), faces };
}

const notes = userNotes();
const rows: PictureRow[] = [];
for (const source of sources(set)) {
  if (!existsSync(source.result)) {
    console.log(`${source.id}: no result`);
    continue;
  }
  const scene = await loadScene(source.dir, source.jointsFile);
  const row = { ...(await measure(source, scene)), user: notes.get(source.id) };
  rows.push(row);
  const user = row.user
    ? `[${row.user.flags.join(',')}] ${row.user.real}/${row.user.design} ${row.user.note.replace(/\s+/g, ' ').slice(0, 60)}`
    : '';
  console.log(`${source.id.padEnd(20)} ${row.aligned ? '' : 'NOT ALIGNED'} ${row.ms} ms  ${user}`);
  for (const f of row.faces)
    console.log(
      `   ${f.kind.padEnd(5)} ${f.key.padEnd(14)} joint ${f.joint ?? '  -  '}${f.restoredNow ? '*' : ' '} pattern ${f.pattern ?? '  -  '} ratio ${f.ratio ?? ' - '} detail ${f.detail ?? ' - '} amount ${f.amount ?? ' - '}/${f.amount75 ?? ' - '}`,
    );
}
mkdirSync(OUT as string, { recursive: true });
writeFileSync(join(OUT as string, `scores-${set}.json`), JSON.stringify(rows, null, 1));
