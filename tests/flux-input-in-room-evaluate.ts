/**
 * Offline evaluation of the 2026-09-27 flux-input-in-room comparison (no AI call). Reads the saved
 * FLUX results and Gemma check answers from test-results/flux-input-in-room/real/, applies the
 * app's own readers (readFluxCheck, fluxResultNotices, reviewResultColors) and scores them against
 * the human ground truth below, written from the images before the checks were run.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-input-in-room-evaluate.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { framing, projectCapture, reviewResultColors, type Pixels } from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  FLUX_LARGE_EXTRAS,
  type FluxCheckResult,
  type FluxExtraKind,
} from '../src/lib/ai-export/check-contract';
import { fluxResultNotices, readFluxCheck } from '../src/lib/ai-export/notices';

const ROOT = 'test-results/flux-input-in-room';
type Truth = {
  input: string;
  large: FluxExtraKind[];
  small: FluxExtraKind[];
  /** Walls whose tile layout visibly changed. */
  tiles: string[];
  kept: string;
  note: string;
};
/** Written by eye from the images (report/pair-*.jpg) before any check call. */
const TRUTH: Record<string, Truth> = {
  'user-example': {
    input: 'user-example',
    large: ['wallSection', 'glassPartition'],
    small: ['showerHead', 'shelf'],
    tiles: [],
    kept: '세면대·변기 유지, 샤워 왼벽→오른벽',
    note: '여백이 바깥 벽으로, 가운데 유리 칸막이, 오른벽 샤워 세트(레인·핸드·수전·토수구)·유리 선반, 천장 등',
  },
  'front-2d-plain-424242': {
    input: 'front-2d',
    large: ['wallSection', 'glassPartition'],
    small: ['showerHead', 'showerHead', 'paperHolder'],
    tiles: [],
    kept: '3/3',
    note: '여백이 바깥 벽으로, 가운데 손잡이 달린 유리문, 천장 레인 샤워, 오른벽 핸드 샤워, 오른쪽 바깥 벽 휴지걸이',
  },
  'front-2d-plain-777001': {
    input: 'front-2d',
    large: ['wallSection', 'glassPartition'],
    small: ['towelBar'],
    tiles: [],
    kept: '3/3',
    note: '여백이 바깥 벽으로, 가운데 천장까지 유리 칸막이, 오른쪽 바깥 벽 수건걸이',
  },
  'eye-center-plain-424242': {
    input: 'eye-center',
    large: ['glassPartition'],
    small: ['paperHolder'],
    tiles: [],
    kept: '3/3',
    note: '뒷벽 가운데에 거의 옆면으로 보이는 희미한 유리 칸막이, 오른벽 휴지걸이',
  },
  'eye-center-plain-777001': {
    input: 'eye-center',
    large: [],
    small: [],
    tiles: [],
    kept: '3/3',
    note: '추가 없음',
  },
  'eye-right-corner-plain-424242': {
    input: 'eye-right-corner',
    large: [],
    small: ['paperHolder', 'flushButton'],
    tiles: ['back', 'left'],
    kept: '3/3',
    note: '뒷벽 휴지걸이·작은 금속판, 뒷벽·왼벽 위아래 타일 배열이 달라짐',
  },
  'eye-right-corner-plain-777001': {
    input: 'eye-right-corner',
    large: ['glassPartition'],
    small: ['showerHead'],
    tiles: [],
    kept: '3/3',
    note: '유리 칸막이(고정 막대 포함), 샤워 옆 천장 레인 샤워헤드',
  },
  'eye-center-bare-424242': {
    input: 'eye-center',
    large: ['glassPartition'],
    small: ['showerHead', 'paperHolder'],
    tiles: [],
    kept: '3/3',
    note: '뒷벽 가운데 손잡이 달린 유리문, 천장 레인 샤워, 오른벽 휴지걸이',
  },
  'eye-center-bare-777001': {
    input: 'eye-center',
    large: [],
    small: ['other'],
    tiles: [],
    kept: '3/3',
    note: '변기 옆 벽에 붙은 작은 통(솔 거치대)',
  },
};

async function load(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
/** How many of `wanted` are covered by `found` (each found item used once). */
function matched(wanted: FluxExtraKind[], found: FluxExtraKind[]) {
  const left = [...found];
  let hits = 0;
  for (const kind of wanted) {
    const i = left.indexOf(kind);
    if (i >= 0) {
      left.splice(i, 1);
      hits++;
    }
  }
  return { hits, extra: left };
}

type Row = {
  name: string;
  truth: Truth;
  answer: unknown;
  usage: unknown;
  reading: ReturnType<typeof readFluxCheck>;
  score: {
    largeTruth: number;
    largeFound: number;
    largeFalse: FluxExtraKind[];
    smallTruth: number;
    smallFound: number;
    smallFalse: FluxExtraKind[];
    tilesTruth: string[];
    tilesSaid: string[];
  };
  notices: string[];
  colors: Record<string, unknown>;
};
const rows: Row[] = [];
for (const [name, truth] of Object.entries(TRUTH)) {
  const check = JSON.parse(readFileSync(`${ROOT}/real/${name}-check.json`, 'utf8'));
  const result: FluxCheckResult = check.result;
  const jobs = JSON.parse(readFileSync(`${ROOT}/jobs.json`, 'utf8'));
  const scene = jobs.check.find((job: { name: string }) => job.name === name).scene;
  const reading = readFluxCheck(result, scene.fixtures);
  const shownLarge = reading.extras.filter((e) => FLUX_LARGE_EXTRAS.includes(e.kind)).map((e) => e.kind);
  const shownSmall = reading.extras.filter((e) => !FLUX_LARGE_EXTRAS.includes(e.kind)).map((e) => e.kind);
  const large = matched(truth.large, shownLarge);
  const small = matched(truth.small, shownSmall);
  const notices = fluxResultNotices({
    products: scene.fixtures.map((f: { kind: string; face: string }) => ({
      id: f.kind,
      label: f.kind,
      where: f.face,
      face: f.face,
    })),
    check: { status: 'done', reading },
    corrected: true,
    showTiles: false,
  });
  // Colour check on the same result, from the render it was made from.
  const resultPath =
    name === 'user-example' ? `${ROOT}/user-example/output.webp` : `${ROOT}/real/${name}.jpg`;
  const image = await load(resultPath);
  let colors: Record<string, unknown>;
  if (name === 'user-example') {
    const capture = await load(`${ROOT}/user-example/input-2000.webp`);
    const layout = fluxInputLayout(capture.width, capture.height);
    const frame = framing(projectCapture(capture, layout, image), image);
    colors = { framing: +frame.score.toFixed(2), aligned: frame.aligned, note: '마스크 없음(구도만)' };
  } else {
    const capture = await load(`${ROOT}/payload/${truth.input}-capture.png`);
    const maskJson = JSON.parse(readFileSync(`${ROOT}/payload/${truth.input}-mask.json`, 'utf8'));
    const mask = { ...maskJson, data: Uint8Array.from(maskJson.data) };
    const layout = fluxInputLayout(capture.width, capture.height);
    const review = reviewResultColors({ capture, mask, layout, result: image });
    if (review.corrected)
      await sharp(Buffer.from(review.corrected.data), {
        raw: { width: review.corrected.width, height: review.corrected.height, channels: 4 },
      })
        .jpeg({ quality: 90 })
        .toFile(`${ROOT}/report/corrected-${name}.jpg`);
    colors = {
      framing: +review.framing.score.toFixed(2),
      aligned: review.framing.aligned,
      faceColorDeltaE: review.changes.map((c) => +c.colorDeltaE.toFixed(1)),
      warnings: review.warnings.length,
      residualMax: review.residual?.length
        ? +Math.max(...review.residual.map((c) => c.colorDeltaE)).toFixed(2)
        : undefined,
    };
  }
  rows.push({
    name,
    truth,
    answer: {
      fixtures: result.fixtures.map((f) => `${f.kind}:${f.present}`),
      extras: result.extras,
      walls: result.walls,
    },
    usage: result.usage ?? check.result?.usage,
    reading,
    score: {
      largeTruth: truth.large.length,
      largeFound: large.hits,
      largeFalse: large.extra,
      smallTruth: truth.small.length,
      smallFound: small.hits,
      smallFalse: small.extra,
      tilesTruth: truth.tiles,
      tilesSaid: reading.tiles,
    },
    notices: notices.warnings.flatMap((w) => w.lines),
    colors,
  });
}
const total = (key: 'largeTruth' | 'largeFound' | 'smallTruth' | 'smallFound') =>
  rows.reduce((sum, row) => sum + row.score[key], 0);
const summary = {
  large: { truth: total('largeTruth'), found: total('largeFound') },
  small: { truth: total('smallTruth'), found: total('smallFound') },
  falseExtras: rows.flatMap((row) =>
    [...row.score.largeFalse, ...row.score.smallFalse].map((k) => `${row.name}:${k}`),
  ),
  tiles: rows.map((row) => ({ name: row.name, truth: row.score.tilesTruth, said: row.score.tilesSaid })),
};
if (!existsSync(`${ROOT}/report`)) throw new Error('report folder missing');
writeFileSync(`${ROOT}/report/evaluation.json`, JSON.stringify({ rows, summary }, null, 2));
for (const row of rows)
  console.log(
    [
      row.name.padEnd(30),
      `large ${row.score.largeFound}/${row.score.largeTruth}`,
      `small ${row.score.smallFound}/${row.score.smallTruth}`,
      `false [${[...row.score.largeFalse, ...row.score.smallFalse].join(',')}]`,
      `tiles ${JSON.stringify(row.score.tilesSaid)}/${JSON.stringify(row.score.tilesTruth)}`,
      `colors ${JSON.stringify(row.colors)}`,
    ].join(' | '),
  );
console.log(JSON.stringify(summary, null, 2));
for (const row of rows) console.log(row.name, '=>', row.notices.join(' / ') || '(알림 없음)');
