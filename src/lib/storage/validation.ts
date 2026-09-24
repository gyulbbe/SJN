import { fixtureVariantErrors } from '../reconstruction/fixture-variants';
import { validateWallFeatures, WALL_FEATURE_MAX_COUNT, WALL_FEATURE_MAX_DEPTH_MM } from '../wall-features';
import { raisedGlassSupportErrors } from '../reconstruction/raised-glass-support';
import { getMaterialImageAssetId } from '../material-images';
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
const reconstructionKindSchema = z.enum([
  'toilet',
  'basin',
  'vanity',
  'bath',
  'mirror',
  'door',
  'window',
  'glassPartition',
  'mirrorCabinet',
  'wallShelf',
  'shower',
  'wallCabinet',
  'lowPartition',
  'showerCurtain',
]);
const reconstructionSourceSchema = z.enum(['model', 'inferred', 'default', 'user']);
const reconstructionProvenanceSchema = z.object({
  kind: reconstructionSourceSchema.optional(),
  mounting: reconstructionSourceSchema.optional(),
  wall: reconstructionSourceSchema.optional(),
  position: reconstructionSourceSchema.optional(),
  dimensions: reconstructionSourceSchema.optional(),
  width: reconstructionSourceSchema.optional(),
  height: reconstructionSourceSchema.optional(),
  depth: reconstructionSourceSchema.optional(),
  shape: reconstructionSourceSchema.optional(),
  bowlCount: reconstructionSourceSchema.optional(),
  pedestalShape: reconstructionSourceSchema.optional(),
  bathLiningColor: reconstructionSourceSchema.optional(),
  mirrorShape: reconstructionSourceSchema.optional(),
  vanityStyle: reconstructionSourceSchema.optional(),
  counterSupport: reconstructionSourceSchema.optional(),
  showerVariant: reconstructionSourceSchema.optional(),
  curtainHardware: reconstructionSourceSchema.optional(),
  toiletLidState: z.enum(['inferred', 'default', 'user']).optional(),
  appearance: reconstructionSourceSchema.optional(),
  color: reconstructionSourceSchema.optional(),
});
const productColorEvidenceSchema = z.object({
  version: z.literal(1),
  method: z.enum(['semantic-interior', 'legacy-observation', 'neutral-optics', 'default', 'user']),
  source: z.enum(['inferred', 'default', 'user']),
  observedColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  requiresReview: z.boolean(),
  reasons: z.array(z.string().max(2000)).max(20),
  sampleCount: z.number().int().nonnegative().max(40_000_000).optional(),
  interiorCount: z.number().int().nonnegative().max(40_000_000).optional(),
});
const raisedGlassSupportSchema = z.object({
  kind: z.enum(['bath-rim', 'shower-curb', 'partition-top']),
  heightMm: number.positive().max(20000),
  provenance: z.object({
    kind: z.enum(['user', 'inferred']),
    height: z.enum(['user', 'default', 'parent', 'inferred']),
  }),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20).optional(),
  bathRim: z
    .object({
      parentFixtureId: id,
      side: z.enum(['left', 'right', 'front', 'back']),
      offsetMm: number.min(-20000).max(20000),
      provenance: z.object({
        parent: z.enum(['user', 'inferred']),
        side: z.enum(['user', 'inferred']),
        offset: z.enum(['user', 'inferred']),
      }),
    })
    .optional(),
  partitionTop: z
    .object({
      parentFixtureId: id,
      offsetMm: number.min(-20000).max(20000),
      provenance: z.object({ parent: z.enum(['user', 'inferred']), offset: z.enum(['user', 'inferred']) }),
    })
    .optional(),
  curb: z
    .object({
      widthMm: number.positive().max(20000),
      depthMm: number.positive().max(20000),
      provenance: z.object({ width: z.enum(['user', 'default']), depth: z.enum(['user', 'default']) }),
    })
    .optional(),
});
export const fixtureReconstructionSchema = z
  .object({
    placementPolicy: z.literal('preserve').optional(),
    support: raisedGlassSupportSchema.optional(),
    baseHeightMm: number.nonnegative().max(20000).optional(),
    yawDegrees: number.min(-360).max(360).optional(),
    basinVariant: z.enum(['wall', 'pedestal', 'vanity']).optional(),
    basinShape: z.enum(['rectangular', 'round']).optional(),
    pedestalShape: z.enum(['round', 'rectangular']).optional(),
    bowlCount: z.union([z.literal(1), z.literal(2)]).optional(),
    toiletLidState: z.enum(['open', 'closed']).optional(),
    hasFrame: z.boolean().optional(),
    opacity: number.min(0).max(1).optional(),
    doorCount: z.number().int().min(1).max(6).optional(),
    shelfStyle: z.enum(['solid', 'rack']).optional(),
    mirrorShape: z.enum(['rectangular', 'oval', 'arched']).optional(),
    vanityStyle: z.enum(['enclosed', 'open-counter']).optional(),
    counterSupport: z.enum(['wall', 'left-panel', 'right-panel', 'both-panels']).optional(),
    showerVariant: z
      .enum(['hand-spray', 'handheld-rail', 'overhead-set', 'handheld-wall', 'overhead-head'])
      .optional(),
    curtainHardware: z.enum(['rod', 'track', 'none']).optional(),
    bathLiningColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    sourceMaterialVersionId: id.optional(),
    provenance: reconstructionProvenanceSchema.optional(),
    colorEvidence: productColorEvidenceSchema.optional(),
    appearanceAssetId: id.optional(),
    orientation: z.enum(['back', 'left', 'right']).optional(),
    version: z.union([z.literal(1), z.literal(2)]),
    kind: reconstructionKindSchema,
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    widthMm: number.positive().max(100000),
    heightMm: number.positive().max(100000),
    depthMm: number.nonnegative().max(100000),
  })
  .superRefine((value, context) => {
    // Reject stale kind-specific options; only an explicit edit may clear them.
    if (value.kind === 'showerCurtain' && (value.version !== 2 || value.depthMm <= 0))
      context.addIssue({
        code: 'custom',
        message: '샤워 커튼은 두께가 있는 버전 2 표준 모형으로 저장해 주세요.',
        path: ['kind'],
      });
    if (
      (value.curtainHardware !== undefined || value.provenance?.curtainHardware !== undefined) &&
      (value.kind !== 'showerCurtain' || value.version !== 2)
    )
      context.addIssue({
        code: 'custom',
        message: '커튼 걸이와 출처는 샤워 커튼 모형에만 적용할 수 있어요.',
        path: ['curtainHardware'],
      });
    if (value.provenance?.curtainHardware !== undefined && value.curtainHardware === undefined)
      context.addIssue({
        code: 'custom',
        message: '커튼 걸이 출처를 저장하려면 걸이 방식을 선택해 주세요.',
        path: ['provenance', 'curtainHardware'],
      });
    if (value.bathLiningColor !== undefined && value.kind !== 'bath')
      context.addIssue({
        code: 'custom',
        message: '욕조 안쪽 색상은 욕조에만 적용할 수 있어요.',
        path: ['bathLiningColor'],
      });
    for (const message of fixtureVariantErrors(value)) context.addIssue({ code: 'custom', message });
    for (const message of raisedGlassSupportErrors({ ...value, face: 'floor' }))
      context.addIssue({ code: 'custom', message, path: ['support'] });
  });
export const projectedQuadSchema = z
  .tuple([fixturePoint, fixturePoint, fixturePoint, fixturePoint])
  .refine(validateQuad, '제품 원근 네 점을 확인해 주세요.');
const fixture = z
  .object({
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
  })
  .superRefine((value, context) => {
    if (value.reconstruction?.kind === 'showerCurtain' && value.roomPlacement?.face !== 'floor')
      context.addIssue({
        code: 'custom',
        message: '샤워 커튼은 바닥 좌표계에 위치와 모형 하단 높이를 저장해 주세요.',
        path: ['roomPlacement', 'face'],
      });
    if (value.reconstruction)
      for (const message of fixtureVariantErrors({
        ...value.reconstruction,
        face: value.roomPlacement?.face,
      }))
        context.addIssue({ code: 'custom', message, path: ['reconstruction'] });
    if (value.reconstruction?.support?.curb) {
      for (const message of raisedGlassSupportErrors({
        ...value.reconstruction,
        face: value.roomPlacement?.face,
        scale: value.roomPlacement?.scale,
      }))
        context.addIssue({ code: 'custom', message, path: ['reconstruction', 'support', 'curb'] });
    }
    if (value.reconstruction?.support && value.roomPlacement?.face !== 'floor')
      context.addIssue({
        code: 'custom',
        message: '높은 유리 지지면은 바닥 좌표 배치가 필요해요.',
        path: ['reconstruction', 'support'],
      });
  });
const wallFeatureBase = {
  version: z.literal(1),
  id,
  face: z.enum(['left', 'back', 'right']),
  leftMm: z.number().finite(),
  topMm: z.number().finite(),
  widthMm: z.number().finite().positive(),
  depthMm: z.number().finite().positive().max(WALL_FEATURE_MAX_DEPTH_MM),
  source: z.literal('user'),
};
const wallFeatureSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...wallFeatureBase, kind: z.literal('closed-niche'), heightMm: z.number().finite().positive() })
    .strict(),
  z.object({ ...wallFeatureBase, kind: z.literal('floor-alcove') }).strict(),
]);
const sceneObject = z.object({
  room: roomDefinitionSchema.optional(),
  wallFeatures: z.array(wallFeatureSchema).max(WALL_FEATURE_MAX_COUNT).optional(),
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
function refineSceneWallFeatures(value: z.infer<typeof sceneObject>, context: z.RefinementCtx) {
  for (const issue of validateWallFeatures(value.room, value.wallFeatures))
    context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  const ids = [
    ...value.surfaces.map((item) => item.id),
    ...value.fixtures.map((item) => item.id),
    ...(value.wallFeatures ?? []).map((item) => item.id),
  ];
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: 'custom', message: '같은 장면 안에 면·제품·벽 구조 ID가 중복되었어요.' });
}
const scene = sceneObject
  .refine(imageLimit, '최대 4천만 화소까지 지원해요.')
  .superRefine(refineSceneWallFeatures);
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
  pattern: z.enum(['grid', 'brick']).optional(),
});
export const reconstructionReviewSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  warnings: z.array(z.string().max(2000)).max(200),
  analysis: z.enum(['complete', 'manual', 'partial']),
  analysisProfile: z.enum(['browser-basic', 'local-quality-v1', 'cloud-browser-v1']).optional(),
  analysisSummary: z
    .object({
      profile: z.enum(['browser-basic', 'local-quality-v1', 'cloud-browser-v1']),
      revision: z.string().min(1).max(300),
      runId: id.optional(),
      modelId: z.string().min(1).max(300).optional(),
      modelRevision: z.string().min(1).max(300).optional(),
      geometryModelId: z.string().min(1).max(300).optional(),
      geometryModelRevision: z.string().min(1).max(300).optional(),
      cameraStatus: z.enum(['estimated', 'held']).optional(),
      placementPolicy: z.enum(['strict', 'visible-relation-estimate']).optional(),
      layoutRevision: z.string().min(1).max(300).optional(),
      estimated: z.literal(true),
    })
    .optional(),
  candidates: z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          kind: reconstructionKindSchema,
          detectedLabel: z.string().max(100).optional(),
          proposedKind: reconstructionKindSchema.optional(),
          source: z.enum(['deeplab', 'qwen', 'gemma', 'user']).optional(),
          reflectionOf: z.string().max(200).optional(),
          placementReview: z
            .object({
              version: z.literal(1),
              status: z.enum(['accepted', 'held']),
              requested: z.object({
                kind: reconstructionKindSchema,
                face: roomFaceSchema,
                u: number,
                v: number,
                widthMm: number,
                heightMm: number,
                depthMm: number,
                baseHeightMm: number.optional(),
                yawDegrees: number.optional(),
                scale: number.optional(),
                orientation: z.enum(['back', 'left', 'right']).optional(),
                provenance: reconstructionProvenanceSchema.optional(),
                support: raisedGlassSupportSchema.optional(),
              }),
              reasons: z.array(z.string().max(2000)).max(20),
              worldBoundsMm: z
                .object({ min: z.tuple([number, number, number]), max: z.tuple([number, number, number]) })
                .optional(),
              overflowMm: z
                .object({
                  left: number.nonnegative(),
                  right: number.nonnegative(),
                  back: number.nonnegative(),
                  front: number.nonnegative(),
                  below: number.nonnegative(),
                  above: number.nonnegative(),
                })
                .optional(),
            })
            .optional(),
          installation: z
            .object({
              mode: z.enum(['wall', 'floor', 'suspended', 'unknown']),
              wall: z.enum(['left', 'back', 'right']).optional(),
              basinVariant: z.enum(['wall', 'pedestal', 'vanity']).optional(),
              reason: z.string().max(2000),
              source: reconstructionSourceSchema,
            })
            .optional(),
          trace: z
            .array(
              z.object({
                stage: z.enum(['analysis', 'candidate', 'installation', 'placement', 'model']),
                outcome: z.enum(['accepted', 'held', 'merged']),
                reason: z.string().max(2000),
              }),
            )
            .max(100)
            .optional(),
          bounds: z
            .object({ left: unit, top: unit, right: unit, bottom: unit })
            .refine((b) => b.left < b.right && b.top < b.bottom),
          foot: normalizedPoint,
          color: z.string().regex(/^#[0-9a-f]{6}$/i),
          colorEvidence: productColorEvidenceSchema.optional(),
          pixels: z.number().int().nonnegative().max(40_000_000),
          evidence: z.object({
            semanticPixels: z.number().int().nonnegative().max(40_000_000),
            meanMargin: number,
            mirrorCompetition: number.min(0).max(1).optional(),
            basinShape: z
              .discriminatedUnion('source', [
                z.object({
                  value: z.enum(['rectangular', 'round']),
                  source: z.literal('semantic-contour'),
                  coverage: unit,
                  fitError: number.nonnegative(),
                  curvature: number,
                }),
                z.object({
                  value: z.literal('rectangular'),
                  source: z.literal('semantic-rgb-contour'),
                  coverage: unit,
                  fitError: number.nonnegative(),
                  edgeSlopes: z.tuple([number, number]),
                  rimIntersection: normalizedPoint,
                  observedEdgeCoverage: z.tuple([unit, unit]),
                }),
              ])
              .optional(),
            bowlCount: z
              .object({
                value: z.literal(2),
                source: z.literal('separate-basin-components'),
                candidateIds: z.array(z.string().min(1).max(200)).length(2),
              })
              .optional(),
            pedestalSupport: z
              .object({ stemWidthRatio: unit, stemHeightRatio: unit, coverage: unit })
              .optional(),
            toiletSurround: unit.optional(),
            contextualKind: z.literal('toilet-assembly').optional(),
            contextualParts: z
              .object({
                toiletPixels: z.number().int().min(0).max(40_000_000),
                surroundRatio: unit,
                bowlPixels: z.number().int().min(0).max(40_000_000),
                lidBounds: z
                  .object({ left: unit, top: unit, right: unit, bottom: unit })
                  .refine((b) => b.left < b.right && b.top < b.bottom)
                  .optional(),
                bowlBounds: z
                  .object({ left: unit, top: unit, right: unit, bottom: unit })
                  .refine((b) => b.left < b.right && b.top < b.bottom)
                  .optional(),
              })
              .optional(),
          }),
          requiresReview: z.boolean().optional(),
          fixtureId: id.optional(),
          status: z.enum(['placed', 'unplaced', 'ignored']),
          warning: z.string().max(2000).optional(),
        })
        .superRefine((candidate, context) => {
          const kind = candidate.proposedKind ?? candidate.kind;
          const mode = candidate.installation?.mode;
          if (
            (mode === 'suspended' && kind !== 'showerCurtain') ||
            (kind === 'showerCurtain' && mode !== undefined && !['suspended', 'unknown'].includes(mode))
          )
            context.addIssue({
              code: 'custom',
              message: '샤워 커튼의 매달기 설치와 위치 좌표계를 구분해 주세요.',
              path: ['installation', 'mode'],
            });
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
          geometrySource: z.enum(['room-boundaries', 'appearance-region', 'visible-floor-region']).optional(),
          geometryEvidence: z
            .object({
              method: z.literal('ceiling-wall-floor-lines'),
              lines: z
                .array(
                  z.object({
                    role: z.enum(['ceiling', 'floor', 'left-junction', 'right-junction']),
                    a: point,
                    b: point,
                    support: unit,
                    span: unit,
                  }),
                )
                .length(4),
              cornerSource: z.literal('line-intersections'),
              reasons: z.array(z.string().max(2000)).max(20),
            })
            .optional(),
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
  labSource: z
    .object({
      version: z.literal(1),
      runId: id,
      inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      reportJson: z
        .string()
        .min(2)
        .max(10 * 1024 * 1024),
      assetIds: z.array(id).max(2000),
      materialVersionIds: z.array(id).max(2000),
    })
    .optional(),
  before: scene,
  room: roomDefinitionSchema,
  cameraVersion: z.literal(1),
  aspect: number.positive().max(100),
  referenceOriginalAssetId: id,
  referencePreviewAssetId: id,
  status: z.enum(['draft', 'confirmed']),
  review: reconstructionReviewSchema.optional(),
});
const projectFrame = sceneObject
  .extend({ comparison: comparisonSchema.optional() })
  .refine(imageLimit, '최대 4천만 화소까지 지원해요.')
  .superRefine(refineSceneWallFeatures)
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
export const roomSourceCameraSchema = z
  .object({
    version: z.literal(1),
    positionMm: z.tuple([
      z.number().finite().min(-1e7).max(1e7),
      z.number().finite().min(-1e7).max(1e7),
      z.number().finite().min(-1e7).max(1e7),
    ]),
    quaternion: z
      .tuple([number, number, number, number])
      .refine((q) => Math.abs(Math.hypot(...q) - 1) <= 1e-5, '사진 시점 회전값을 확인해 주세요.'),
    verticalFovDegrees: number.min(5).max(150),
    image: z
      .object({ width: z.number().int().min(1).max(100000), height: z.number().int().min(1).max(100000) })
      .strict()
      .refine((image) => image.width / image.height >= 0.01 && image.width / image.height <= 100),
    referenceRoom: z
      .object({
        widthMm: number.min(500).max(20000),
        depthMm: number.min(500).max(20000),
        heightMm: number.min(1000).max(6000),
      })
      .strict(),
    source: z.enum(['estimated', 'user']),
  })
  .strict();
export const roomViewSchema = z
  .object({
    version: z.literal(1),
    quaternion: z
      .tuple([number, number, number, number])
      .refine(
        (value) => Math.abs(Math.hypot(...value) - 1) <= 0.000001,
        '공간 시점 회전값이 올바르지 않아요.',
      ),
    zoom: number.min(0.25).max(8),
    pan: z.object({ x: number.min(-4).max(4), y: number.min(-4).max(4) }).strict(),
    sourceCamera: roomSourceCameraSchema.optional(),
    projection: z.enum(['source-photo', 'room-fit']).optional(),
  })
  .strict()
  .refine(
    (view) => view.projection !== 'source-photo' || !!view.sourceCamera,
    '사진 시점 정보가 필요합니다.',
  );

function createProjectV3Schema(maxDesigns: number) {
  const workspaceShape = {
    roomView: roomViewSchema.optional(),
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
const quaternionSchema = z
  .tuple([number, number, number, number])
  .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 0.001, '회전값은 정규화된 quaternion이어야 해요.');
export const product3dReferenceSchema = z
  .object({
    version: z.literal(1),
    meshAssetId: id,
    inputAssetId: id,
    pose: z
      .object({
        objectQuaternion: quaternionSchema,
        cameraQuaternion: quaternionSchema,
        zoom: number.positive().max(100),
      })
      .strict(),
    modelId: z.string().min(1).max(300),
    modelRevision: z.string().min(1).max(300),
    shading: z.enum(['lit', 'baked']).optional(),
  })
  .strict();
export const materialInputSchema = z
  .object({
    catalog: z
      .object({
        brandId: id.optional(),
        subcategoryId: id.optional(),
        colorIds: z.array(id).max(20),
        compositionIds: z.array(id).max(20),
        finishIds: z.array(id).max(20),
      })
      .optional(),
    composition: z.string().max(2100).optional(),
    subcategoryName: z.string().max(100).optional(),
    reconstruction: z
      .object({ version: z.union([z.literal(1), z.literal(2)]), kind: z.string().min(1).max(100) })
      .optional(),
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
      'glassPartition',
      'mirrorCabinet',
      'wallShelf',
      'wallCabinet',
      'lowPartition',
      'showerCurtain',
    ]),
    scope: z.enum(['personal', 'shared']),
    description: z.string().max(10000),
    color: z.string().max(2100),
    finish: z.string().max(2100),
    widthMm: number.positive().max(100000),
    heightMm: number.positive().max(100000),
    depthMm: number.nonnegative().max(100000),
    usage: z.enum(['wall', 'floor', 'both']),
    installation: z.enum(['floor', 'wall', 'embedded', 'suspended']),
    coverAssetId: id.optional(),
    imageAssetIds: z.array(id).max(100).optional(),
    textureAssetIds: z.array(id).max(100),
    views: z
      .array(
        z.object({
          assetId: id,
          direction: z.string().max(200),
          anchor: normalizedPoint,
          product3d: product3dReferenceSchema.optional(),
        }),
      )
      .max(100),
    defaultGroutWidth: number.min(0).max(100),
    defaultGroutColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    defaultPattern: z.enum(['grid', 'brick']),
  })
  .superRefine((input, context) => {
    if (input.category === 'showerCurtain' && input.depthMm <= 0)
      context.addIssue({
        code: 'custom',
        message: '커튼 모형의 전체 깊이는 0보다 커야 해요.',
        path: ['depthMm'],
      });
    if ((input.category === 'showerCurtain') !== (input.installation === 'suspended'))
      context.addIssue({
        code: 'custom',
        message: '샤워 커튼은 매달기 설치 방식으로 저장해 주세요.',
        path: ['installation'],
      });
    if (
      input.reconstruction &&
      (input.reconstruction.kind === 'showerCurtain' || input.category === 'showerCurtain') &&
      (input.reconstruction.version !== 2 || input.reconstruction.kind !== input.category)
    )
      context.addIssue({
        code: 'custom',
        message: '샤워 커튼 재구성 자재는 버전 2 커튼 분류로 저장해 주세요.',
        path: ['reconstruction'],
      });
  })
  .refine((input) => !!getMaterialImageAssetId(input), '타일 텍스처 또는 제품 사진을 등록해 주세요.');
const assetMetadataBase = {
  id,
  name: z.string().min(1).max(300),
};
export const assetMetadataSchema = z.discriminatedUnion('kind', [
  z.object({
    ...assetMetadataBase,
    kind: z.enum(['original', 'preview', 'texture', 'product', 'background', 'thumbnail']),
    sourceAssetId: id.optional(),
    derivation: z
      .enum(['upload-preview', 'manual-alpha', 'ai-alpha', 'ai-multiview', 'ai-product3d', 'rectified'])
      .optional(),
  }),
  z.object({ ...assetMetadataBase, kind: z.literal('product-mesh'), sourceAssetId: id }),
]);
export const identifierSchema = id;
