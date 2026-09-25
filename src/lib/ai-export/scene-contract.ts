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
export const FLUX_MAX_FIXTURES = 12;
export const FLUX_MAX_SURFACES = 8;
export const FLUX_MAX_SCENE_BYTES = 16 * 1024;

export type FluxFixtureKind = (typeof FLUX_FIXTURE_KINDS)[number];
export type FluxFixtureForm = (typeof FLUX_FIXTURE_FORMS)[number];
export type FluxFace = (typeof FLUX_FACES)[number];
export type FluxFinish = (typeof FLUX_FINISHES)[number];

const hex = z.string().regex(/^#[0-9a-f]{6}$/);
const mm = z.number().finite().min(1).max(20000);
const unit = z.number().finite().min(0).max(1);
/** [left, top, right, bottom] of image 0, 0–1. */
const box = z
  .tuple([unit, unit, unit, unit])
  .refine(([left, top, right, bottom]) => right > left && bottom > top, '빈 영역이에요.');

export const fluxFixtureSchema = z.strictObject({
  kind: z.enum(FLUX_FIXTURE_KINDS),
  forms: z.array(z.enum(FLUX_FIXTURE_FORMS)).max(4),
  face: z.enum(FLUX_FACES),
  color: hex,
  finish: z.enum(FLUX_FINISHES),
  /** Width × height × depth. */
  sizeMm: z.tuple([mm, mm, mm]),
  box,
});
export const fluxSurfaceSchema = z.strictObject({
  faces: z.array(z.enum(FLUX_FACES)).min(1).max(4),
  color: hex,
  tileMm: z.tuple([mm, mm]),
  pattern: z.enum(['grid', 'brick']),
  groutColor: hex,
  groutMm: z.number().finite().min(0).max(50),
  finish: z.enum(FLUX_FINISHES),
});
export const fluxSceneSchema = z.strictObject({
  version: z.literal(1),
  fixtures: z.array(fluxFixtureSchema).max(FLUX_MAX_FIXTURES),
  surfaces: z.array(fluxSurfaceSchema).max(FLUX_MAX_SURFACES),
});

export type FluxFixture = z.infer<typeof fluxFixtureSchema>;
export type FluxSurface = z.infer<typeof fluxSurfaceSchema>;
export type FluxScene = z.infer<typeof fluxSceneSchema>;
