import { z } from 'zod';

/**
 * What the editor knows about the placed products, sent next to the After image so FLUX does not
 * have to guess a 25px object. Only enums, numbers and colours: no user-typed names ever reach the
 * model, and the server writes every sentence of the prompt itself. No product images are sent: in
 * a real comparison, close-up references made the model reframe the shot and enlarge fixtures.
 */
export const FLUX_FIXTURE_KINDS = [
  'toilet',
  'basin',
  'vanity',
  'bath',
  'shower',
  'faucet',
  'mirror',
  'mirrorCabinet',
  'wallCabinet',
  'wallShelf',
  'glassPartition',
  'lowPartition',
  'showerCurtain',
  'door',
  'window',
] as const;
export const FLUX_FIXTURE_FORMS = [
  'wall-hung',
  'floor-standing',
  'pedestal',
  'countertop',
  'built-in',
  'suspended',
  'lid-open',
  'lid-closed',
  'handheld',
  'handheld-rail',
  'overhead',
  'rectangular',
  'round',
  'oval',
  'arched',
] as const;
export const FLUX_FACES = ['floor', 'back', 'left', 'right'] as const;
export const FLUX_FINISHES = ['matte', 'semi-gloss', 'glossy', 'polished', 'metal'] as const;
/** Where a product faces in the room, from its photo's angle name (see product-direction.ts). */
export const FLUX_FACINGS = ['front', 'right', 'left', 'back'] as const;
export const FLUX_MAX_FIXTURES = 12;
export const FLUX_MAX_SURFACES = 8;
export const FLUX_MAX_SCENE_BYTES = 16 * 1024;

export type FluxFixtureKind = (typeof FLUX_FIXTURE_KINDS)[number];
export type FluxFixtureForm = (typeof FLUX_FIXTURE_FORMS)[number];
export type FluxFace = (typeof FLUX_FACES)[number];
export type FluxFinish = (typeof FLUX_FINISHES)[number];
export type FluxFacing = (typeof FLUX_FACINGS)[number];

export const fluxHex = z.string().regex(/^#[0-9a-f]{6}$/);
export const fluxMm = z.number().finite().min(1).max(20000);
const unit = z.number().finite().min(0).max(1);
/** [left, top, right, bottom] of image 0, 0–1. */
const box = z
  .tuple([unit, unit, unit, unit])
  .refine(([left, top, right, bottom]) => right > left && bottom > top, '빈 영역이에요.');

export const fluxFixtureSchema = z.strictObject({
  kind: z.enum(FLUX_FIXTURE_KINDS),
  forms: z.array(z.enum(FLUX_FIXTURE_FORMS)).max(4),
  face: z.enum(FLUX_FACES),
  color: fluxHex,
  finish: z.enum(FLUX_FINISHES),
  /** Absent for a standard model, or a photo that names no horizontal direction (위, 아래). */
  facing: z.enum(FLUX_FACINGS).optional(),
  /** Width × height × depth. */
  sizeMm: z.tuple([fluxMm, fluxMm, fluxMm]),
  box,
});
export const fluxSurfaceSchema = z.strictObject({
  faces: z.array(z.enum(FLUX_FACES)).min(1).max(4),
  color: fluxHex,
  tileMm: z.tuple([fluxMm, fluxMm]),
  pattern: z.enum(['grid', 'brick']),
  groutColor: fluxHex,
  groutMm: z.number().finite().min(0).max(50),
  finish: z.enum(FLUX_FINISHES),
});
/**
 * The ceiling an in-room view shows: its paint colour and the one flat light panel. Absent for the
 * front composite and older requests, which show no ceiling.
 */
export const fluxCeilingSchema = z.strictObject({
  color: fluxHex,
  light: z.enum(['flat-panel']),
});
/**
 * The composite export sends the room without its fixtures (they are put back on top afterwards):
 * `empty-room` bare, `placeholders` with a flat grey stand-in where each fixture goes. Absent: the
 * room is sent with its fixtures, as before. An empty-room request lists no fixtures.
 */
export const FLUX_ROOM_MODES = ['empty-room', 'placeholders'] as const;
export type FluxRoomMode = (typeof FLUX_ROOM_MODES)[number];
/**
 * How image 0 shows the room. `cutaway`: from outside, the walls facing the camera removed on
 * purpose, a plain white backdrop around it. Absent: an older request (the front composite).
 */
export const FLUX_VIEWS = ['cutaway'] as const;
export const fluxSceneSchema = z
  .strictObject({
    version: z.literal(1),
    fixtures: z.array(fluxFixtureSchema).max(FLUX_MAX_FIXTURES),
    surfaces: z.array(fluxSurfaceSchema).max(FLUX_MAX_SURFACES),
    ceiling: fluxCeilingSchema.optional(),
    mode: z.enum(FLUX_ROOM_MODES).optional(),
    view: z.enum(FLUX_VIEWS).optional(),
  })
  .refine((scene) => !scene.mode || !scene.fixtures.length, '빈 방 요청에는 설비를 보내지 않아요.');

export type FluxFixture = z.infer<typeof fluxFixtureSchema>;
export type FluxSurface = z.infer<typeof fluxSurfaceSchema>;
export type FluxCeiling = z.infer<typeof fluxCeilingSchema>;
export type FluxScene = z.infer<typeof fluxSceneSchema>;
