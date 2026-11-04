/**
 * D2 of the direction-photo methods trial: Clef-flash (multiple choice, answers as probabilities, input
 * tokens only) through the trial's Worker (8806), every call in the ledger with its billed tokens.
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/judge.ts side <grades.json> <out-name>
 *     the side question over a human-graded set (round 2: does Clef agree with people?)
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/judge.ts candidates <round> <products> <methods>
 *     the side and same-product questions over a round's answers (round 4, only if round 2 passed)
 *
 * Answers go to judge/<out-name>.jsonl; a picture already asked is not asked again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { LEDGER, OTHER_LEDGERS, OUT, ROOT } from './paths.mjs';
import { budgetCheck, clefCost, CLEF_FLASH, endsRun, type Row } from './budget';

const args = process.argv.slice(3);
const [mode] = args;
const JUDGE = path.join(OUT, 'judge');
mkdirSync(JUDGE, { recursive: true });
const readRows = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
const others = OTHER_LEDGERS.flatMap(readRows);

/** The side question as people graded: 옆 / 살짝 사선 / 사선 (docs/toilet-side-view-results-20261021.md). */
export const SIDE_QUESTION = {
  type: 'choice',
  instructions:
    'The picture should show the product from exactly one side, as in a side elevation drawing. How is the product turned in this picture?',
  criteria: {
    side: 'a pure side view: only one side of the product is seen and its front points straight to the left or the right of the picture',
    slight: 'slightly turned: mostly a side view, but a little of its front (or its back) is also seen',
    angled: 'clearly turned: a three-quarter view, or close to a front view, or turned the other way',
  },
};
export const SIDE_LABEL: Record<string, string> = { side: '옆', slight: '살짝 사선', angled: '사선' };
const SAME_QUESTION = {
  type: 'choice',
  instructions:
    'The left half is a photo of a real product. The right half is a picture made from it from another direction. Is the right one the same product (same shape details, same parts, same colour)?',
  criteria: { same: 'the same product', different: 'a different product, or parts added or missing' },
};

async function dataUrl(file: string, edge = 480) {
  const png = await sharp(file)
    .flatten({ background: '#ffffff' })
    .resize(edge, edge, { fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${png.toString('base64')}`;
}
async function pair(photo: string, answer: string) {
  const half = async (file: string) =>
    sharp(file)
      .flatten({ background: '#ffffff' })
      .resize(400, 400, { fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer();
  const png = await sharp({ create: { width: 820, height: 400, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await half(photo), left: 0, top: 0 },
      { input: await half(answer), left: 420, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${png.toString('base64')}`;
}

type Ask = { key: string; image: string; question: Record<string, unknown>; state: string };
async function ask(out: string, round: string, item: Ask) {
  const at = new Date().toISOString();
  // About 1,300 input tokens for one 480 px picture (catalog-match round 3): estimated as 1,600.
  const estimate = clefCost(1600);
  const check = budgetCheck(readRows(LEDGER), others, { at, cost: estimate });
  if (!check.ok) {
    appendFileSync(
      LEDGER,
      JSON.stringify({
        at,
        round,
        engine: 'cf',
        model: CLEF_FLASH,
        item: item.key,
        neurons: 0,
        status: 'refused',
        error: check.reason,
      }) + '\n',
    );
    throw new Error(`refused: ${check.reason}`);
  }
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:8806/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLEF_FLASH,
      input: {
        model: 'clef-flash',
        state: item.state,
        questions: { q: item.question },
        images: [item.image],
      },
    }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    result?: {
      answers?: { q?: { choice: string; probabilities: Record<string, number> } };
      usage?: { input_tokens?: number };
    };
    error?: string;
  };
  const tokens = body.result?.usage?.input_tokens;
  const neurons = tokens !== undefined ? clefCost(tokens) : estimate;
  appendFileSync(
    LEDGER,
    JSON.stringify({
      at,
      round,
      engine: 'cf',
      model: CLEF_FLASH,
      item: item.key,
      neurons: Number(neurons.toFixed(3)),
      neuronsFrom: tokens !== undefined ? 'usage' : 'estimate',
      status: response.status,
      ms: Date.now() - started,
      ...(body.error ? { error: body.error.slice(0, 300) } : {}),
    }) + '\n',
  );
  if (!response.ok) {
    if (endsRun(response.status, body.error)) throw new Error(`stopped: ${response.status} ${body.error}`);
    return undefined;
  }
  const answer = body.result?.answers?.q;
  appendFileSync(
    path.join(JUDGE, `${out}.jsonl`),
    JSON.stringify({ key: item.key, choice: answer?.choice, probabilities: answer?.probabilities }) + '\n',
  );
  return answer;
}
const done = (out: string) =>
  new Set(
    existsSync(path.join(JUDGE, `${out}.jsonl`))
      ? readFileSync(path.join(JUDGE, `${out}.jsonl`), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { key: string }).key)
      : [],
  );

if (mode === 'side') {
  const [, gradesFile, out] = args;
  const grades = JSON.parse(readFileSync(gradesFile, 'utf8')) as { file: string; grade: string }[];
  const seen = done(out);
  for (const g of grades) {
    if (seen.has(g.file)) continue;
    const file = path.isAbsolute(g.file) ? g.file : path.join(ROOT, g.file);
    await ask(out, 'r2', {
      key: g.file,
      image: await dataUrl(file),
      question: SIDE_QUESTION,
      state: 'A product picture made for a catalogue.',
    });
    process.stdout.write('.');
  }
  // Agreement with the people's grades: three classes, and side vs not.
  const answers = new Map(
    readFileSync(path.join(JUDGE, `${out}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { key: string; choice: string })
      .map((a) => [a.key, a.choice]),
  );
  let three = 0,
    two = 0,
    n = 0;
  for (const g of grades) {
    const choice = answers.get(g.file);
    if (!choice) continue;
    n++;
    if (SIDE_LABEL[choice] === g.grade) three++;
    if ((choice === 'side') === (g.grade === '옆')) two++;
  }
  console.log(
    `\n${out}: ${n} answered, three classes ${three}/${n} = ${(three / n).toFixed(2)}, side vs not ${two}/${n} = ${(two / n).toFixed(2)}`,
  );
} else if (mode === 'candidates') {
  const [, round, productList, methodList] = args;
  const out = `${round}-candidates`;
  const seen = done(out);
  for (const product of productList.split(','))
    for (const method of methodList.split(',')) {
      const dir = path.join(OUT, 'runs', round, product, method);
      if (!existsSync(dir)) continue;
      const photo = path.join(OUT, 'prep', product, 'refs', '1.png');
      for (const file of readdirSync(dir).filter((f) => /^(front|left|right|back)-\d+\.png$/.test(f))) {
        const key = `${round}/${product}/${method}/${file}`;
        if (seen.has(key + '#same')) continue;
        if (!file.startsWith('front') && !seen.has(key + '#side'))
          await ask(out, 'r4', {
            key: key + '#side',
            image: await dataUrl(path.join(dir, file)),
            question: SIDE_QUESTION,
            state: 'A product picture made for a catalogue.',
          });
        await ask(out, 'r4', {
          key: key + '#same',
          image: await pair(photo, path.join(dir, file)),
          question: SAME_QUESTION,
          state: 'Two pictures side by side.',
        });
        process.stdout.write('.');
      }
    }
  console.log(`\n${out} done`);
} else throw new Error('side | candidates');
