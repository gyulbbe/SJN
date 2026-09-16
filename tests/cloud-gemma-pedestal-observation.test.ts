import { describe, expect, it } from 'vitest';
import {
  cloudGemmaFixtureAppearanceJsonSchemaFor,
  cloudGemmaFixtureAppearancePrompt,
} from '../src/lib/reconstruction/cloud-gemma-appearance';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  FIXTURE_APPEARANCE_RULE_REVISION,
  fixtureAppearanceJsonSchemaFor,
  fixtureAppearancePrompt,
  parseFixtureAppearance,
  type FixtureAppearanceObservation,
} from '../src/lib/reconstruction/fixture-appearance-observation';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

const room = { ...DEFAULT_ROOM };
const image = { width: 960, height: 1280 };
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  candidates: [],
  planes: [],
  warnings: [],
};
const candidate = (changes: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id: 'support-test',
  kind: 'basin',
  bounds: { left: 0.24, top: 0.37, right: 0.61, bottom: 0.89 },
  mounting: 'floor',
  wall: 'unknown',
  basinStyle: 'pedestal',
  shape: 'rectangular',
  reflection: 'physical',
  evidence: ['Synthetic contract fixture, not model inference.'],
  uncertainty: [],
  ...changes,
});
const scene = (item = candidate()): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates: [item],
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['camera unresolved'] },
});
const row = (changes: Partial<FixtureAppearanceObservation> = {}): FixtureAppearanceObservation => ({
  id: 'support-test',
  kind: 'pedestal_basin',
  context: 'physical',
  note: 'A separate visible support reaches the floor below the bowl.',
  sameObjectAs: null,
  shape: 'oval',
  counterSupport: 'unknown',
  ...changes,
});
const parse = (observation: FixtureAppearanceObservation, source = scene()) =>
  parseFixtureAppearance(JSON.stringify({ schemaVersion: 1, observations: [observation] }), source);
function layoutInput(observation?: FixtureAppearanceObservation, userShape?: 'round' | 'rectangular') {
  const source = scene();
  const appearance = observation ? parse(observation, source) : undefined;
  const understanding = appearance?.understanding ?? source;
  const strictResult = buildCandidatePipeline(
    understanding,
    baseline,
    room,
    image,
    undefined,
    appearance?.understanding,
    undefined,
    undefined,
    undefined,
    undefined,
    userShape ? { 'support-test': userShape } : undefined,
  );
  return { understanding, baseline, room, image, strictResult, appearance };
}

describe('Cloudflare-only pedestal cross-section observation', () => {
  it('extends only the Cloudflare prompt/schema without mutating the legacy wire contract', () => {
    const source = scene();
    const original = structuredClone(source);
    const localPrompt = fixtureAppearancePrompt(source);
    const localSchema = fixtureAppearanceJsonSchemaFor(source);
    const localSchemaJson = JSON.stringify(localSchema);
    const cloudPrompt = cloudGemmaFixtureAppearancePrompt(source);
    const cloudSchema = cloudGemmaFixtureAppearanceJsonSchemaFor(source);
    expect(cloudPrompt.startsWith(localPrompt)).toBe(true);
    expect(cloudPrompt).toContain('Never infer pedestalShape from shape, the bowl outline');
    expect(cloudPrompt).toContain('hidden, cropped or ambiguous');
    expect(cloudSchema.properties.observations.items.properties.pedestalShape.enum).toEqual([
      'round',
      'rectangular',
      'unknown',
    ]);
    expect(cloudSchema.properties.observations.items.required).toContain('pedestalShape');
    expect(JSON.stringify(localSchema)).toBe(localSchemaJson);
    expect(fixtureAppearancePrompt(source)).toBe(localPrompt);
    expect(JSON.stringify(fixtureAppearanceJsonSchemaFor(source))).toBe(localSchemaJson);
    expect(localPrompt).not.toContain('pedestalShape');
    expect(localSchemaJson).not.toContain('pedestalShape');
    expect(source).toEqual(original);
    expect(FIXTURE_APPEARANCE_CONTRACT).toBe('fixed-candidate-appearance-v1');
    expect(FIXTURE_APPEARANCE_PROMPT_REVISION).toBe(1);
    expect(FIXTURE_APPEARANCE_RULE_REVISION).toBe('appearance-decision-v3');
  });

  it('reparses historical observations with optional absence preserved in the saved ledger', () => {
    const legacy = row();
    const raw = JSON.stringify({ schemaVersion: 1, observations: [legacy] });
    const parsed = parseFixtureAppearance(raw, scene());
    const saved = JSON.parse(JSON.stringify(parsed));
    expect(parsed.observations).toEqual([legacy]);
    expect(Object.hasOwn(parsed.observations[0], 'pedestalShape')).toBe(false);
    expect(Object.hasOwn(parsed.decisions[0].observation, 'pedestalShape')).toBe(false);
    expect(parsed.modelOptions).toEqual({});
    expect(parseFixtureAppearance(raw, scene())).toEqual(saved);
    expect(parsed.ruleRevision).toBe('appearance-decision-v3');
  });

  it.each([
    ['oval', 'rectangular'],
    ['rectangular', 'round'],
  ] as const)('observes bowl %s independently from support %s', (shape, pedestalShape) => {
    const source = scene();
    const original = structuredClone(source);
    const parsed = parse(row({ shape, pedestalShape }), source);
    expect(parsed.modelOptions['support-test']).toEqual({
      pedestalShape,
      provenance: { pedestalShape: 'model' },
    });
    expect(parsed.understanding.candidates[0].shape).toBe(shape === 'oval' ? 'round' : 'rectangular');
    expect(parsed.decisions[0].observation.pedestalShape).toBe(pedestalShape);
    expect(source).toEqual(original);
  });

  it.each(['oval', 'rectangular'] as const)('does not infer the pedestal from %s bowl shape', (shape) => {
    for (const observation of [row({ shape }), row({ shape, pedestalShape: 'unknown' })]) {
      const parsed = parse(observation);
      expect(parsed.modelOptions).toEqual({});
      const output = buildEstimatedCandidatePipeline(layoutInput(observation));
      expect(output.plans['support-test']?.basinVariant).toBe('pedestal');
      expect(output.plans['support-test']?.pedestalShape).toBeUndefined();
      expect(output.plans['support-test']?.provenance?.pedestalShape).not.toBe('model');
    }
  });

  it.each(['wall_basin', 'enclosed_vanity', 'mirror', 'toilet'] as const)(
    'rejects observed support shape on non-pedestal kind %s',
    (kind) => {
      expect(() => parse(row({ kind, pedestalShape: 'rectangular' }))).toThrow('기둥');
      expect(() => parse(row({ kind, pedestalShape: 'unknown' }))).not.toThrow();
    },
  );

  it('rejects unsupported or null cross-sections rather than converting them to a default observation', () => {
    for (const pedestalShape of ['triangular', null]) {
      expect(() =>
        parseFixtureAppearance(
          JSON.stringify({ schemaVersion: 1, observations: [{ ...row(), pedestalShape }] }),
          scene(),
        ),
      ).toThrow();
    }
  });

  it.each(['reflected', 'uncertain', 'not-fixture'] as const)(
    'keeps the observation but does not apply a pedestal option in %s context',
    (context) => {
      const parsed = parse(row({ context, pedestalShape: 'rectangular' }));
      expect(parsed.observations[0].pedestalShape).toBe('rectangular');
      expect(parsed.modelOptions['support-test']).toBeUndefined();
    },
  );

  it('does not apply a support observation over a user-confirmed candidate or a held reflection', () => {
    for (const item of [
      candidate({ provenance: { kind: 'user' } }),
      candidate({ reflection: 'reflected' }),
    ]) {
      const source = scene(item);
      const parsed = parse(row({ pedestalShape: 'rectangular' }), source);
      expect(parsed.decisions[0].status).toBe('held');
      expect(parsed.understanding.candidates[0]).toMatchObject({
        kind: item.kind,
        basinStyle: item.basinStyle,
        reflection: item.reflection,
      });
      expect(parsed.decisions[0].original).toEqual(item);
      expect(parsed.modelOptions).toEqual({});
    }
  });
});

describe('observed pedestal option reaches the standard estimated model', () => {
  it.each(['round', 'rectangular'] as const)(
    'retains explicit model %s and provenance after strict placement is held',
    (pedestalShape) => {
      const input = layoutInput(
        row({ shape: pedestalShape === 'round' ? 'rectangular' : 'oval', pedestalShape }),
      );
      expect(input.strictResult.plans['support-test']).toBeNull();
      const original = structuredClone(input);
      const output = buildEstimatedCandidatePipeline(input);
      expect(output.plans['support-test']).toMatchObject({
        kind: 'basin',
        basinVariant: 'pedestal',
        pedestalShape,
        provenance: { pedestalShape: 'model' },
      });
      expect(input).toEqual(original);
    },
  );

  it.each(['round', 'rectangular'] as const)(
    'keeps user %s when strict placement is held and the model disagrees',
    (userShape) => {
      const observed = userShape === 'round' ? 'rectangular' : 'round';
      const input = layoutInput(row({ pedestalShape: observed }), userShape);
      expect(input.strictResult.plans['support-test']).toBeNull();
      expect(input.strictResult.pipeline.userPedestalShapes).toEqual({ 'support-test': userShape });
      const output = buildEstimatedCandidatePipeline(input);
      expect(output.plans['support-test']).toMatchObject({
        pedestalShape: userShape,
        provenance: { pedestalShape: 'user' },
      });
    },
  );

  it('keeps user choice with no new observation, an unknown value, or a held appearance decision', () => {
    const inputs = [
      layoutInput(undefined, 'rectangular'),
      layoutInput(row({ pedestalShape: 'unknown' }), 'rectangular'),
      layoutInput(row({ pedestalShape: 'round' }), 'rectangular'),
    ];
    inputs[2].appearance!.decisions[0].status = 'held';
    for (const input of inputs) {
      const output = buildEstimatedCandidatePipeline(input);
      expect(output.plans['support-test']).toMatchObject({
        pedestalShape: 'rectangular',
        provenance: { pedestalShape: 'user' },
      });
    }
  });

  it('keeps a user model option from an existing strict plan even without a correction map', () => {
    const input = layoutInput(row({ pedestalShape: 'round' }));
    const plan = buildEstimatedCandidatePipeline(input).plans['support-test']!;
    input.strictResult.plans['support-test'] = {
      ...plan,
      pedestalShape: 'rectangular',
      provenance: { ...plan.provenance, pedestalShape: 'user' },
    };
    const output = buildEstimatedCandidatePipeline(input);
    expect(output.plans['support-test']).toMatchObject({
      pedestalShape: 'rectangular',
      provenance: { pedestalShape: 'user' },
    });
  });

  it('does not leak a supplied pedestal model option into a wall basin', () => {
    const input = layoutInput(row({ kind: 'wall_basin' }));
    input.appearance!.modelOptions['support-test'] = {
      pedestalShape: 'rectangular',
      provenance: { pedestalShape: 'model' },
    };
    const output = buildEstimatedCandidatePipeline(input);
    expect(output.plans['support-test']?.basinVariant).toBe('wall');
    expect(output.plans['support-test']?.pedestalShape).toBeUndefined();
    expect(output.plans['support-test']?.provenance?.pedestalShape).not.toBe('model');
  });
});
