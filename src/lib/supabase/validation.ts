import { materialUsageSchema } from '../material-usage-validation';
import {
  comparisonFrameError,
  projectFrameError,
  HISTORY_LIMIT,
  MAX_COMPARISON_DESIGNS,
  MAX_DESIGNS,
  LEGACY_MAX_DESIGNS,
  DESIGN_LIMIT_MESSAGE,
  COMPARISON_LIMIT_MESSAGE,
} from '../comparison';
import { roomDefinitionSchema, roomFaceSchema, roomPlacementSchema } from '../room-validation';
import { z } from 'zod';
import { validateQuad } from '../render/math';
import { materialPricingSchema, quoteDocumentSchema } from '../quote-validation';

const id = z.string().uuid();
const number = z.number().finite().min(-1_000_000).max(1_000_000);
const point = z.object({ x: number, y: number });
const normalizedPoint = z.object({ x: number.min(0).max(1), y: number.min(0).max(1) });
const fixturePoint = z.object({ x: number.min(-10).max(10), y: number.min(-10).max(10) });
const color = z.object({
  exposure: number.min(-8).max(8),
  contrast: number.min(0).max(4),
  saturation: number.min(0).max(4),
  warmth: number.min(-2).max(2),
});
const mask = z
  .object({
    polygon: z.array(normalizedPoint).max(10000),
    polygons: z.array(z.array(normalizedPoint).max(10000)).max(1000).optional(),
    holes: z.array(z.array(normalizedPoint).max(10000)).max(1000).optional(),
    strokes: z
      .array(
        z
          .object({
            points: z.array(normalizedPoint).max(50000),
            radius: number.nonnegative().max(2),
            erase: z.boolean(),
          })
          .refine(
            (stroke) => stroke.radius > 0 || stroke.points.length >= 3,
            '다각형 복원 영역에는 점이 세 개 이상 필요해요.',
          ),
      )
      .max(10000),
  })
  .refine(
    (value) =>
      value.polygon.length +
        (value.polygons ?? []).reduce((sum, polygon) => sum + polygon.length, 0) +
        (value.holes ?? []).reduce((sum, polygon) => sum + polygon.length, 0) <=
      32768,
    '한 마스크의 경계점은 총 32,768개 이하여야 해요.',
  );
const tile = z.object({
  rotation: number.min(-36000).max(36000),
  offsetX: number,
  offsetY: number,
  groutWidth: number.min(0).max(100),
  groutColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  pattern: z.enum(['grid', 'brick']),
  seed: number.int(),
  shading: number.min(0).max(1),
});
export const reconstructionBandSchema = z
  .object({
    from: z.number().finite().min(0).max(1),
    to: z.number().finite().min(0).max(1),
  })
  .refine((b) => b.from < b.to, '벽 구간의 시작은 끝보다 작아야 해요.');
const surface = z.object({
  reconstructionBand: reconstructionBandSchema.optional(),
  roomFace: roomFaceSchema.optional(),
  geometryMode: z.enum(['room', 'manual']).optional(),
  id,
  name: z.string().max(200),
  kind: z.enum(['floor', 'wall']),
  mask,
  quad: z
    .tuple([normalizedPoint, normalizedPoint, normalizedPoint, normalizedPoint])
    .refine(validateQuad, '볼록한 원근 네 점이 필요해요.'),
  widthMm: number.positive().max(1_000_000),
  heightMm: number.positive().max(1_000_000),
  calibrated: z.boolean(),
  materialVersionId: id.optional(),
  tile,
  color,
});
export const fixtureReconstructionSchema = z.object({
  appearanceAssetId: id.optional(),
  orientation: z.enum(['back', 'left', 'right']).optional(),
  version: z.literal(1),
  kind: z.enum(['toilet', 'basin', 'vanity', 'bath', 'mirror', 'door', 'window']),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  widthMm: number.positive().max(100000),
  heightMm: number.positive().max(100000),
  depthMm: number.nonnegative().max(100000),
});
export const projectedQuadSchema = z
  .tuple([fixturePoint, fixturePoint, fixturePoint, fixturePoint])
  .refine(validateQuad, '제품 원근 네 점을 확인해 주세요.');
const fixture = z.object({
  reconstruction: fixtureReconstructionSchema.optional(),
  projectedQuad: projectedQuadSchema.optional(),
  roomPlacement: roomPlacementSchema.optional(),
  id,
  name: z.string().max(200),
  materialVersionId: id,
  viewIndex: z.number().int().min(0).max(99),
  position: fixturePoint,
  width: number.positive().max(10),
  height: number.positive().max(10),
  rotation: number.min(-36000).max(36000),
  anchor: normalizedPoint,
  locked: z.boolean(),
  shadow: z.object({
    x: fixturePoint.shape.x,
    y: fixturePoint.shape.y,
    opacity: number.min(0).max(1),
    blur: number.min(0).max(1),
    scale: number.min(0).max(10),
  }),
  occlusion: mask,
  color,
});
const sceneObject = z.object({
  room: roomDefinitionSchema.optional(),
  originalAssetId: id,
  previewAssetId: id,
  backgroundAssetId: id.optional(),
  imageWidth: z.number().int().positive().max(100000),
  imageHeight: z.number().int().positive().max(100000),
  surfaces: z.array(surface).max(100),
  protection: mask,
  fixtures: z.array(fixture).max(200),
  color,
});
const imageLimit = (value: { imageWidth: number; imageHeight: number }) =>
  value.imageWidth * value.imageHeight <= 40_000_000;
const scene = sceneObject.refine(imageLimit, '최대 4천만 화소까지 지원해요.');
const unit = z.number().finite().min(0).max(1);
const reconstructionTileSchema = z.object({
  groutColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  widthMm: number.positive().max(100000),
  heightMm: number.positive().max(100000),
  groutWidth: number.min(0).max(100),
  estimated: z.boolean(),
});
const reviewSchema = z.object({
  version: z.literal(1),
  warnings: z.array(z.string().max(2000)).max(200),
  analysis: z.enum(['complete', 'manual', 'partial']),
  candidates: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        kind: z.enum(['toilet', 'basin', 'vanity', 'bath', 'mirror', 'door', 'window']),
        bounds: z
          .object({ left: unit, top: unit, right: unit, bottom: unit })
          .refine((b) => b.left < b.right && b.top < b.bottom),
        foot: normalizedPoint,
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
        pixels: z.number().int().nonnegative().max(40_000_000),
        evidence: z.object({
          semanticPixels: z.number().int().nonnegative().max(40_000_000),
          meanMargin: number,
        }),
        requiresReview: z.boolean().optional(),
        fixtureId: id.optional(),
        status: z.enum(['placed', 'unplaced', 'ignored']),
        warning: z.string().max(2000).optional(),
      }),
    )
    .max(200),
  planes: z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          face: roomFaceSchema,
          quad: z
            .tuple([normalizedPoint, normalizedPoint, normalizedPoint, normalizedPoint])
            .refine(validateQuad),
          depthStart: unit,
          depthEnd: unit,
          horizontalStart: unit.optional(),
          horizontalEnd: unit.optional(),
          verticalStart: unit.optional(),
          verticalEnd: unit.optional(),
          confirmed: z.boolean(),
          bands: z
            .array(
              z.object({ from: unit, to: unit, tile: reconstructionTileSchema }).refine((b) => b.from < b.to),
            )
            .max(12)
            .refine((bands) => bands.every((b, i) => i === 0 || b.from >= bands[i - 1].to))
            .optional(),
          tile: reconstructionTileSchema,
        })
        .refine(
          (plane) =>
            plane.depthStart < plane.depthEnd &&
            (plane.verticalStart ?? 0) < (plane.verticalEnd ?? 1) &&
            (plane.horizontalStart ?? 0) < (plane.horizontalEnd ?? 1),
        ),
    )
    .max(100),
});
export const comparisonSchema = z.object({
  before: scene,
  room: roomDefinitionSchema,
  cameraVersion: z.literal(1),
  aspect: number.positive().max(100),
  referenceOriginalAssetId: id,
  referencePreviewAssetId: id,
  status: z.enum(['draft', 'confirmed']),
  review: reviewSchema.optional(),
});
const projectFrame = sceneObject
  .extend({ comparison: comparisonSchema.optional() })
  .refine(imageLimit, '최대 4천만 화소까지 지원해요.')
  .refine(
    (frame) => !frame.comparison || !comparisonFrameError(frame, frame.comparison),
    '비교 장면의 치수와 화면 비율을 확인해 주세요.',
  );
export const legacyProjectSchema = z
  .object({
    comparison: comparisonSchema.optional(),
    quote: quoteDocumentSchema.optional(),
    id,
    ownerId: z.string(),
    name: z.string().trim().min(1).max(200),
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    editRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storageRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scene,
    history: z.object({ past: z.array(projectFrame).max(50), future: z.array(projectFrame).max(50) }),
    viewport: z.object({ zoom: number.min(0.1).max(10), pan: point }),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    thumbnailAssetId: id.optional(),
  })
  .refine(
    (project) => !project.comparison || !comparisonFrameError(project.scene, project.comparison),
    '비교 장면의 치수와 화면 비율을 확인해 주세요.',
  );
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const designFrameSchema = z.object({
  scene,
  quote: quoteDocumentSchema.optional(),
  materialUsage: materialUsageSchema.optional(),
});
const beforeFrameSchema = z.object({ baseline: scene, comparison: comparisonSchema.optional() });
export const designDocumentSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200),
  sourceDesignId: id.optional(),
  materialUsage: materialUsageSchema.optional(),
  renderRevision: revision.optional(),
  scene,
  quote: quoteDocumentSchema.optional(),
  revision,
  history: z.object({
    past: z.array(designFrameSchema).max(HISTORY_LIMIT),
    future: z.array(designFrameSchema).max(HISTORY_LIMIT),
  }),
  createdAt: timestamp,
  updatedAt: timestamp,
  thumbnailAssetId: id.optional(),
});
const sharedWorkspaceSchema = z.object({
  baseline: scene,
  comparison: comparisonSchema.optional(),
  revision,
  beforeHistory: z.object({
    past: z.array(beforeFrameSchema).max(HISTORY_LIMIT),
    future: z.array(beforeFrameSchema).max(HISTORY_LIMIT),
  }),
  legacyHistory: z
    .object({
      past: z.array(projectFrame).max(HISTORY_LIMIT),
      future: z.array(projectFrame).max(HISTORY_LIMIT),
    })
    .optional(),
});
function createProjectV3Schema(maxDesigns: number) {
  const workspaceShape = {
    shared: sharedWorkspaceSchema,
    designs: z.array(designDocumentSchema).max(maxDesigns, DESIGN_LIMIT_MESSAGE),
    activeDesignId: id.nullable(),
    comparisonDesignIds: z.array(id).max(MAX_COMPARISON_DESIGNS, COMPARISON_LIMIT_MESSAGE),
    viewport: z.object({ zoom: number.min(0.1).max(10), pan: point }),
  };
  // Checkpoints deliberately have no roomHistory field: backups cannot nest recursively.
  const workspaceSnapshotSchema = z.object(workspaceShape).strict();
  return z
    .object({
      ...workspaceShape,
      id,
      ownerId: z.string(),
      name: z.string().trim().min(1).max(200),
      schemaVersion: z.literal(3),
      editRevision: revision,
      storageRevision: revision,
      createdAt: timestamp,
      updatedAt: timestamp,
      thumbnailAssetId: id.optional(),
      roomHistory: z
        .object({
          past: workspaceSnapshotSchema.optional(),
          future: workspaceSnapshotSchema.optional(),
        })
        .strict(),
    })
    .strict()
    .superRefine((project, context) => {
      const error = projectFrameError(project, maxDesigns);
      if (error) context.addIssue({ code: 'custom', message: error });
      if (project.roomHistory.past && project.roomHistory.future)
        context.addIssue({ code: 'custom', message: '공간 복원 백업은 최근 한 번만 보관할 수 있어요.' });
    });
}
export const projectV3Schema = createProjectV3Schema(MAX_DESIGNS);
/** Only use with a trusted stored document or with projectWriteError against its prior revision. */
export const storedProjectV3Schema = createProjectV3Schema(LEGACY_MAX_DESIGNS);
export const storedProjectSchema = z.union([legacyProjectSchema, storedProjectV3Schema]);
// Legacy inputs remain accepted at API boundaries and are upgraded only for a successful write.
export const projectSchema = z.union([legacyProjectSchema, projectV3Schema]);
export const materialInputSchema = z.object({
  reconstruction: z.object({ version: z.literal(1), kind: z.string().min(1).max(100) }).optional(),
  pricing: materialPricingSchema.optional(),
  name: z.string().trim().min(1).max(200),
  brand: z.string().max(200),
  code: z.string().max(200),
  category: z.enum([
    'tile',
    'toilet',
    'basin',
    'vanity',
    'bath',
    'shower',
    'faucet',
    'mirror',
    'door',
    'window',
  ]),
  scope: z.enum(['personal', 'shared']),
  description: z.string().max(10000),
  color: z.string().max(100),
  finish: z.string().max(200),
  widthMm: number.positive().max(100000),
  heightMm: number.positive().max(100000),
  depthMm: number.nonnegative().max(100000),
  usage: z.enum(['wall', 'floor', 'both']),
  installation: z.enum(['floor', 'wall', 'embedded']),
  coverAssetId: id,
  imageAssetIds: z.array(id).max(100),
  textureAssetIds: z.array(id).max(100),
  views: z.array(z.object({ assetId: id, direction: z.string().max(200), anchor: normalizedPoint })).max(100),
  defaultGroutWidth: number.min(0).max(100),
  defaultGroutColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  defaultPattern: z.enum(['grid', 'brick']),
});
export const assetMetadataSchema = z.object({
  id,
  name: z.string().min(1).max(300),
  kind: z.enum(['original', 'preview', 'texture', 'product', 'background', 'thumbnail']),
  sourceAssetId: id.optional(),
  derivation: z.enum(['upload-preview', 'manual-alpha', 'ai-alpha', 'rectified']).optional(),
});
export const identifierSchema = id;
