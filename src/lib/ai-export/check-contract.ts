import { z } from 'zod';
import {
  FLUX_FACES,
  FLUX_FIXTURE_KINDS,
  FLUX_MAX_FIXTURES,
  type FluxFace,
  type FluxFixtureKind,
} from './scene-contract';
import { FLUX_KIND_NOUNS } from './prompt';

/**
 * Checking a FLUX result with Gemma: does each placed fixture still appear where it was, did the
 * model add objects nobody placed, and does each visible wall still show one tile in one layout?
 * The request carries the result image and, per fixture, only its kind and box (plus which walls
 * are in view). The server writes the question; no user text reaches the model. One click, one
 * call, no automatic retry.
 */
export const FLUX_CHECK_MAX_IMAGE_BYTES = 1_572_864;
export const FLUX_CHECK_MAX_EDGE = 1024;
export const FLUX_CHECK_MAX_SCENE_BYTES = 4096;
export const FLUX_CHECK_PROMPT_REVISION = 'flux-fixture-check-v2';
/** At most this many unplaced objects are reported. */
export const FLUX_CHECK_MAX_EXTRAS = 8;

export const FLUX_CHECK_WALLS = ['left', 'back', 'right'] as const;
export type FluxCheckWall = (typeof FLUX_CHECK_WALLS)[number];

const unit = z.number().finite().min(0).max(1);
export const fluxCheckSceneSchema = z
  .strictObject({
    version: z.literal(1),
    fixtures: z
      .array(
        z.strictObject({
          kind: z.enum(FLUX_FIXTURE_KINDS),
          box: z
            .tuple([unit, unit, unit, unit])
            .refine(([left, top, right, bottom]) => right > left && bottom > top, '빈 영역이에요.'),
          /**
           * The wall or floor it is installed on, so the model can tell the placed shower from a
           * second one on another wall. Absent in older requests.
           */
          face: z.enum(FLUX_FACES).optional(),
        }),
      )
      .max(FLUX_MAX_FIXTURES),
    /** The walls the input shows, each once; absent in older requests (no tile question then). */
    walls: z
      .array(z.enum(FLUX_CHECK_WALLS))
      .max(FLUX_CHECK_WALLS.length)
      .refine((walls) => new Set(walls).size === walls.length, '같은 벽이 겹쳐요.')
      .optional(),
    /**
     * The composite export sent the room empty (optionally with grey placeholders), so there are no
     * fixtures to find: only added objects are asked about. Without it, at least one fixture is listed.
     */
    room: z.enum(['empty', 'placeholders']).optional(),
  })
  .refine(
    (scene) => (scene.room ? scene.fixtures.length === 0 : scene.fixtures.length > 0),
    '확인할 설비 목록이 올바르지 않아요.',
  );
export type FluxCheckScene = z.infer<typeof fluxCheckSceneSchema>;

/** What the model says it sees in a fixture's box: a listed kind, another object, or nothing. */
export const FLUX_CHECK_SEEN = [...FLUX_FIXTURE_KINDS, 'other', 'none'] as const;
export type FluxCheckSeen = (typeof FLUX_CHECK_SEEN)[number];
/**
 * Objects the model may add on its own (bathrooms get "completed"): the large ones change the room
 * (window, door, glass partition, a new piece of wall), the small ones are accessories.
 */
export const FLUX_EXTRA_KINDS = [
  'window',
  'door',
  'glassPartition',
  'wallSection',
  'shelf',
  'towelBar',
  'paperHolder',
  'showerHead',
  'flushButton',
  'mirror',
  'cabinet',
  'bathtub',
  'toilet',
  'basin',
  'other',
] as const;
export type FluxExtraKind = (typeof FLUX_EXTRA_KINDS)[number];
export const FLUX_LARGE_EXTRAS: readonly FluxExtraKind[] = [
  'window',
  'door',
  'glassPartition',
  'wallSection',
];
/** Where an added object is: on a wall, the floor, the ceiling, or standing free in the room. */
export const FLUX_EXTRA_PLACES = ['left', 'back', 'right', 'floor', 'ceiling', 'middle'] as const;
export type FluxExtraPlace = (typeof FLUX_EXTRA_PLACES)[number];
export type FluxExtra = { kind: FluxExtraKind; place: FluxExtraPlace };
export type FluxWallCheck = { face: FluxCheckWall; uniformTiles: 'yes' | 'no' | 'unsure' };
export type FluxCheckAnswer = { index: number; present: 'yes' | 'no' | 'unsure'; seenAs: FluxCheckSeen };
export type FluxCheckResult = {
  fixtures: (FluxCheckAnswer & { kind: FluxFixtureKind })[];
  /** Absent from an older server's answer: the result was not checked for added objects. */
  extras?: FluxExtra[];
  /** One per requested wall; absent when no walls were asked about. */
  walls?: FluxWallCheck[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

const EXTRA_WORDS: Record<FluxExtraKind, string> = {
  window: 'window',
  door: 'door',
  glassPartition: 'glass shower partition or glass door',
  wallSection: 'new piece of wall, partition wall or wall panel',
  shelf: 'shelf or niche shelf',
  towelBar: 'towel bar, ring or hook',
  paperHolder: 'toilet paper holder',
  showerHead: 'shower head, shower rail or shower mixer',
  flushButton: 'flush button or flush plate',
  mirror: 'mirror',
  cabinet: 'cabinet or vanity unit',
  bathtub: 'bathtub',
  toilet: 'toilet',
  basin: 'washbasin',
  other: 'any other object',
};
const WALL_WORDS: Record<FluxCheckWall, string> = {
  left: 'left wall',
  back: 'back wall',
  right: 'right wall',
};
const FACE_WORDS: Record<FluxFace, string> = { ...WALL_WORDS, floor: 'floor' };

const percent = (value: number) => Math.round(value * 100);
export function fluxCheckPrompt(scene: FluxCheckScene) {
  const lines = scene.fixtures.map(
    ({ kind, box: [left, top, right, bottom], face }, i) =>
      `${i + 1}. ${FLUX_KIND_NOUNS[kind]}${face ? ` on the ${FACE_WORDS[face]}` : ''} at x ${percent(left)}–${percent(right)}%, y ${percent(top)}–${percent(bottom)}%`,
  );
  const walls = scene.walls ?? [];
  const tiles = walls.length
    ? [
        `For each wall in walls (${walls.map((face) => WALL_WORDS[face]).join(', ')}), answer uniformTiles: "yes" if the whole wall shows one tile in one regular layout, "no" if a band, panel or area of a different tile, pattern or layout appears on it, "unsure" if you cannot tell.`,
      ]
    : [];
  const wallsExample = walls.length ? `,"walls":[{"face":"${walls[0]}","uniformTiles":"yes"}]` : '';
  if (scene.room)
    return [
      `Image 0 is an edited photograph of a bathroom that was given as an empty room${scene.room === 'placeholders' ? ', with plain grey shapes marking where fixtures will be added later' : ''}. Nothing should have been added to it.`,
      'List in extras every object you can see anywhere in the image, at most 8:',
      `- kind: ${FLUX_EXTRA_KINDS.map((kind) => `"${kind}" (${EXTRA_WORDS[kind]})`).join(', ')}.`,
      '- place: "left", "back" or "right" for the wall it is on, "floor", "ceiling", or "middle" for something standing free in the room.',
      `The room's own walls, floor and ceiling, one flat ceiling light panel, tile joints, reflections and shadows are not extras${scene.room === 'placeholders' ? ', and neither are the plain grey placeholder shapes' : ''}. An empty list is a normal answer.`,
      ...tiles,
      `Answer with JSON only: {"fixtures":[],"extras":[]${wallsExample}}`,
    ].join('\n');
  return [
    'Image 0 is an edited photograph of a bathroom. Each numbered fixture below must still be in it, in the region given as percentages of the image width (x) and height (y) from the top-left corner.',
    'For each fixture, look inside its region and answer:',
    '- present: "yes" if the region shows that kind of fixture, "no" if it shows a different object or nothing, "unsure" if you cannot tell.',
    '- seenAs: what the region mainly shows: one of the fixture kinds (toilet, basin, vanity, bath, shower, faucet, mirror, mirrorCabinet, wallCabinet, wallShelf, glassPartition, lowPartition, showerCurtain, door, window), "other" for a different object, or "none" for bare wall or floor.',
    'Judge the object, not its colour, material or lighting.',
    ...lines,
    'The numbered fixtures are the only objects that were placed. Then list in extras every other object you can see anywhere in the image, at most 8:',
    `- kind: ${FLUX_EXTRA_KINDS.map((kind) => `"${kind}" (${EXTRA_WORDS[kind]})`).join(', ')}.`,
    '- place: "left", "back" or "right" for the wall it is on, "floor", "ceiling", or "middle" for something standing free in the room.',
    "Parts of a numbered fixture (its faucet, seat, drain, hose or mounting) are not extras. An object of a numbered kind somewhere else (for example a second shower on another wall) is an extra, with its own place. The room's own walls, floor and ceiling, one flat ceiling light panel, tile joints, reflections and shadows are not extras. An empty list is a normal answer.",
    ...tiles,
    `Answer with JSON only, one fixtures entry per fixture in order: {"fixtures":[{"index":1,"present":"yes","seenAs":"toilet"}],"extras":[]${wallsExample}}`,
  ].join('\n');
}

export function fluxCheckJsonSchema(count: number, walls: readonly FluxCheckWall[] = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fixtures', 'extras', ...(walls.length ? ['walls'] : [])],
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
            index: { type: 'integer', minimum: 1, maximum: Math.max(1, count) },
            present: { type: 'string', enum: ['yes', 'no', 'unsure'] },
            seenAs: { type: 'string', enum: [...FLUX_CHECK_SEEN] },
          },
        },
      },
      extras: {
        type: 'array',
        maxItems: FLUX_CHECK_MAX_EXTRAS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'place'],
          properties: {
            kind: { type: 'string', enum: [...FLUX_EXTRA_KINDS] },
            place: { type: 'string', enum: [...FLUX_EXTRA_PLACES] },
          },
        },
      },
      ...(walls.length
        ? {
            walls: {
              type: 'array',
              minItems: walls.length,
              maxItems: walls.length,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['face', 'uniformTiles'],
                properties: {
                  face: { type: 'string', enum: [...walls] },
                  uniformTiles: { type: 'string', enum: ['yes', 'no', 'unsure'] },
                },
              },
            },
          }
        : {}),
    },
  };
}

/**
 * Strict reading of the model's answer: one entry per fixture, every index exactly once. Extras and
 * walls are held to the same rules when present (known words; each asked wall once, no other);
 * an answer without them (the v1 shape) still reads, as "not checked" for those parts, so a missing
 * section never costs the fixture answers. Repeated kind-and-place extras are kept once.
 */
export function parseFluxCheck(text: string, scene: FluxCheckScene): Omit<FluxCheckResult, 'usage'> {
  const count = scene.fixtures.length,
    walls = scene.walls ?? [];
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
      extras: z
        .array(z.strictObject({ kind: z.enum(FLUX_EXTRA_KINDS), place: z.enum(FLUX_EXTRA_PLACES) }))
        .max(FLUX_CHECK_MAX_EXTRAS)
        .optional(),
      walls: z
        .array(
          z.strictObject({
            face: z.enum(FLUX_CHECK_WALLS),
            uniformTiles: z.enum(['yes', 'no', 'unsure']),
          }),
        )
        .optional(),
    })
    .parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
  const byIndex = new Map(answer.fixtures.map((entry) => [entry.index, entry]));
  if (byIndex.size !== count) throw new Error('설비 번호가 겹치거나 빠졌어요.');
  const byWall = new Map((answer.walls ?? []).map((entry) => [entry.face, entry]));
  if (
    answer.walls &&
    (answer.walls.length !== walls.length ||
      byWall.size !== walls.length ||
      walls.some((face) => !byWall.has(face)))
  )
    throw new Error('벽 답이 겹치거나 빠졌어요.');
  const seen = new Set<string>();
  const extras = answer.extras?.filter(({ kind, place }) => {
    const key = `${kind}:${place}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    fixtures: scene.fixtures.map((fixture, i) => ({ ...byIndex.get(i + 1)!, kind: fixture.kind })),
    ...(extras ? { extras } : {}),
    ...(answer.walls && walls.length ? { walls: walls.map((face) => byWall.get(face)!) } : {}),
  };
}

/** A fixture to warn about: the model says it is not there (or is something else). */
export function fluxCheckWarnings(result: FluxCheckResult) {
  return result.fixtures.filter((entry) => entry.present === 'no');
}
