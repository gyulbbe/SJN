/**
 * Edge candidates' pictures (no AI call, docs/fixture-shadows-20261118.md): per result the O1 picture
 * (tests/fixture-streaks, the baseline) and the edge rules on top of it.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shadows/edge-pictures.ts [--set reg] [--ids a,b]
 *   [--rules r1,r1e2]
 * Output: test-results/fixture-shadows-20261118/pictures/<id>.<rule>.png, edge-<set>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pixels } from '../../src/lib/ai-export/color';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { PIECE_SHADOW, setPieceRule } from '../fixture-streaks/outline-method';
import { refineTrial } from '../fixture-streaks/refine-trial';
import { JOINT_TRIAL } from './joints-trial';
import { refineShadow } from './refine-shadow';
import { bodyTrial, type BodyRule } from './body-method';
import { edgeTrial, type EdgeRule } from './edge-method';
import { loadInput } from './load';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'reg') as HazeSet;
const only = arg('ids') ? new Set(arg('ids').split(',')) : undefined;
setPieceRule(28, 0.7, 0.3);

const RIM = { band: 3, gap: 6, lift: 0.8, inside: 0.08 };
/** joint: R1 (the joints step restores a face fully next to a fixture); edge: edge-method.ts. */
/** shadow: O1 also turns the model's shadow pieces to wall (outline-method.ts PIECE_SHADOW). */
/** backdrop: the joints step also restores fully at the backdrop (joints-trial.ts backdropRim). */
export const RULES: Record<
  string,
  { joint?: number; shadow?: boolean; backdrop?: boolean; faces?: boolean; edge?: EdgeRule; body?: BodyRule }
> = {
  e1: { edge: { soft: true } },
  e2: { edge: { rim: RIM } },
  r1: { joint: 1 },
  r1e1: { joint: 1, edge: { soft: true } },
  r1e2: { joint: 1, edge: { rim: RIM } },
  r1e12: { joint: 1, edge: { soft: true, rim: RIM } },
  rhe1: { joint: 0.5, edge: { soft: true } },
  rhe12: { joint: 0.5, edge: { soft: true, rim: RIM } },
  s: { shadow: true },
  srhe12: { joint: 0.5, shadow: true, edge: { soft: true, rim: RIM } },
  sr1e12: { joint: 1, shadow: true, edge: { soft: true, rim: RIM } },
  sb5: { joint: 0.5, shadow: true, edge: { soft: true, rim: RIM }, body: { dark: 0.5, bright: 0.8 } },
  sb3: { joint: 0.5, shadow: true, edge: { soft: true, rim: RIM }, body: { dark: 0.3, bright: 0.6 } },
  sb5l: {
    joint: 0.5,
    shadow: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.5, bright: 0.8, lift: 1 },
  },
  bk: { backdrop: true },
  sb5lk: {
    joint: 0.5,
    shadow: true,
    backdrop: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.5, bright: 0.8, lift: 1 },
  },
  sb5lkf: {
    joint: 0.5,
    shadow: true,
    backdrop: true,
    faces: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.5, bright: 0.8, lift: 1 },
  },
  sb5lkfc: {
    joint: 0.5,
    shadow: true,
    backdrop: true,
    faces: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.5, bright: 0.8, lift: 1, cap: 0.5 },
  },
  sb5lkfc3: {
    joint: 0.5,
    shadow: true,
    backdrop: true,
    faces: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.5, bright: 0.8, lift: 1, cap: 0.3 },
  },
  sb3lkf: {
    joint: 0.5,
    shadow: true,
    backdrop: true,
    faces: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.3, bright: 0.6, lift: 1 },
  },
  sb3l: {
    joint: 0.5,
    shadow: true,
    edge: { soft: true, rim: RIM },
    body: { dark: 0.3, bright: 0.6, lift: 1 },
  },
};
const chosen = arg('rules', 'r1,r1e2').split(',');
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });

const differs = (a: Pixels, b: Pixels) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) > 12 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 12 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 12
    )
      n++;
  return n;
};
const rows = [];
let mismatch = 0;
for (const source of haze(set)) {
  if (only && !only.has(source.id)) continue;
  const loaded = await loadInput(source);
  if (!loaded) continue;
  const { input } = loaded;
  JOINT_TRIAL.fixtureRim = 0;
  JOINT_TRIAL.backdropRim = false;
  JOINT_TRIAL.faceRim = false;
  PIECE_SHADOW.on = false;
  const trial = refineTrial({ ...input, pieces: true });
  const base = trial.shown ?? input.raw;
  if (!trial.outline) continue;
  JOINT_TRIAL.fixtureRim = 0;
  JOINT_TRIAL.backdropRim = false;
  JOINT_TRIAL.faceRim = false;
  PIECE_SHADOW.on = false;
  const same = refineShadow({ ...input, pieces: true }).shown ?? input.raw;
  if (differs(same, base)) mismatch++;
  const row: Record<string, unknown> = { id: source.id };
  const notes: string[] = [];
  for (const name of chosen) {
    const rule = RULES[name];
    const started = performance.now();
    JOINT_TRIAL.fixtureRim = rule.joint ?? 0;
    JOINT_TRIAL.backdropRim = !!rule.backdrop;
    JOINT_TRIAL.faceRim = !!rule.faces;
    PIECE_SHADOW.on = !!rule.shadow;
    const refined =
      rule.joint || rule.shadow || rule.backdrop || rule.faces
        ? refineShadow({ ...input, pieces: true })
        : trial;
    const shown = refined.shown ?? input.raw;
    const { image, log } = rule.edge
      ? edgeTrial({
          raw: input.raw,
          shown,
          outline: refined.outline!,
          cuts: input.cuts,
          fixtures: input.fixtures,
          rule: rule.edge,
        })
      : { image: shown, log: { soft: 0, rim: 0 } };
    const body = rule.body
      ? bodyTrial({
          result: image,
          capture: input.capture,
          mask: input.mask,
          layout: input.layout,
          fixtures: input.fixtures,
          resultMask: refined.outline!.colourMask,
          rule: rule.body,
        })
      : undefined;
    const final = body?.image ?? image;
    const ms = Math.round(performance.now() - started);
    writeFileSync(join(dir, `${source.id}.${name}.png`), await png(final));
    const moved = differs(base, final);
    row[name] = { ...log, moved, ms, ...(body ? { body: body.log } : {}) };
    const bodyNote = body
      ? ` body ${body.log.map((b) => `${b.kind} ${b.fDark}/${b.fBright} L${b.median}/${b.refMedian}`).join(' ')}`
      : '';
    notes.push(`${name} soft ${log.soft} rim ${log.rim} moved ${moved} ${ms}ms${bodyNote}`);
  }
  rows.push(row);
  console.log(source.id.padEnd(24), notes.join(' | '));
}
console.log(`trial copy off = O1: ${mismatch ? `${mismatch} differ` : 'all same'}`);
writeFileSync(join(OUT as string, `edge-${set}.json`), JSON.stringify(rows, null, 1));
