import { z } from 'zod';
import { FLUX_FIXTURE_KINDS, FLUX_MAX_FIXTURES, type FluxFixtureKind } from './scene-contract';
import { FLUX_KIND_NOUNS } from './prompt';

/**
 * Checking a FLUX result with Gemma: does each placed fixture still appear where it was? The
 * request carries the result image and, per fixture, only its kind and box. The server writes the
 * question; no user text reaches the model. One click, one call, no automatic retry.
 */
export const FLUX_CHECK_MAX_IMAGE_BYTES = 1_572_864;
export const FLUX_CHECK_MAX_EDGE = 1024;
export const FLUX_CHECK_MAX_SCENE_BYTES = 4096;
export const FLUX_CHECK_PROMPT_REVISION = 'flux-fixture-check-v1';

const unit = z.number().finite().min(0).max(1);
export const fluxCheckSceneSchema = z.strictObject({
  version: z.literal(1),
  fixtures: z
    .array(
      z.strictObject({
        kind: z.enum(FLUX_FIXTURE_KINDS),
        box: z
          .tuple([unit, unit, unit, unit])
          .refine(([left, top, right, bottom]) => right > left && bottom > top, '빈 영역이에요.'),
      }),
    )
    .min(1)
    .max(FLUX_MAX_FIXTURES),
});
export type FluxCheckScene = z.infer<typeof fluxCheckSceneSchema>;

/** What the model says it sees in a fixture's box: a listed kind, another object, or nothing. */
export const FLUX_CHECK_SEEN = [...FLUX_FIXTURE_KINDS, 'other', 'none'] as const;
export type FluxCheckSeen = (typeof FLUX_CHECK_SEEN)[number];
export type FluxCheckAnswer = { index: number; present: 'yes' | 'no' | 'unsure'; seenAs: FluxCheckSeen };
export type FluxCheckResult = {
  fixtures: (FluxCheckAnswer & { kind: FluxFixtureKind })[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

const percent = (value: number) => Math.round(value * 100);
export function fluxCheckPrompt(scene: FluxCheckScene) {
  const lines = scene.fixtures.map(
    ({ kind, box: [left, top, right, bottom] }, i) =>
      `${i + 1}. ${FLUX_KIND_NOUNS[kind]} at x ${percent(left)}–${percent(right)}%, y ${percent(top)}–${percent(bottom)}%`,
  );
  return [
    'Image 0 is an edited photograph of a bathroom. Each numbered fixture below must still be in it, in the region given as percentages of the image width (x) and height (y) from the top-left corner.',
    'For each fixture, look inside its region and answer:',
    '- present: "yes" if the region shows that kind of fixture, "no" if it shows a different object or nothing, "unsure" if you cannot tell.',
    '- seenAs: what the region mainly shows: one of the fixture kinds (toilet, basin, vanity, bath, shower, faucet, mirror, mirrorCabinet, wallCabinet, wallShelf, glassPartition, lowPartition, showerCurtain, door, window), "other" for a different object, or "none" for bare wall or floor.',
    'Judge the object, not its colour, material or lighting.',
    ...lines,
    'Answer with JSON only, one entry per fixture in order: {"fixtures":[{"index":1,"present":"yes","seenAs":"toilet"}]}',
  ].join('\n');
}

export function fluxCheckJsonSchema(count: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fixtures'],
    properties: {
      fixtures: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'present', 'seenAs'],
          properties: {
            index: { type: 'integer', minimum: 1, maximum: count },
            present: { type: 'string', enum: ['yes', 'no', 'unsure'] },
            seenAs: { type: 'string', enum: [...FLUX_CHECK_SEEN] },
          },
        },
      },
    },
  };
}

/** Strict reading of the model's answer: one entry per fixture, every index exactly once. */
export function parseFluxCheck(text: string, scene: FluxCheckScene): FluxCheckResult['fixtures'] {
  const count = scene.fixtures.length;
  const answer = z
    .strictObject({
      fixtures: z
        .array(
          z.strictObject({
            index: z.number().int().min(1).max(count),
            present: z.enum(['yes', 'no', 'unsure']),
            seenAs: z.enum(FLUX_CHECK_SEEN),
          }),
        )
        .length(count),
    })
    .parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
  const byIndex = new Map(answer.fixtures.map((entry) => [entry.index, entry]));
  if (byIndex.size !== count) throw new Error('설비 번호가 겹치거나 빠졌어요.');
  return scene.fixtures.map((fixture, i) => ({ ...byIndex.get(i + 1)!, kind: fixture.kind }));
}

/** A fixture to warn about: the model says it is not there (or is something else). */
export function fluxCheckWarnings(result: FluxCheckResult) {
  return result.fixtures.filter((entry) => entry.present === 'no');
}
