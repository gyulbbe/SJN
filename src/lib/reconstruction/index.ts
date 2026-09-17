import { photoAnalysisSignal, type AnalysisCachePolicy } from './analysis-cache-policy';
import { createProjectMaterial } from '@/lib/repositories/project-material';
import { fixtureVariantErrors, openCounterDefaults, showerVariantDefaults } from './fixture-variants';
import { resolveProductColor } from './product-color';
import { bathRimFixtureSupport, partitionTopFixtureSupport } from './candidate-bath-rim';
import { hasParentGlassSupport } from './raised-glass-support';
import { resolveBathRimPlacement } from './bath-rim';
import { validateSourceFixture } from './source-camera';
import { inspectStrictPlacement, StrictPlacementError } from './strict-placement';
import type { CandidateFixturePlan } from './candidate-pipeline';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type MaterialInput,
  type MaterialVersion,
  type ProjectDocument,
  type Scene,
} from '../types';
import { normalizeProjectDocument } from '../comparison';
import type { RoomDefinition, RoomFace } from '../room-types';
import type { RepositoryOperations } from '../repositories/contracts';
import { getRepositories } from '../repositories';
import { canvasBlob, importImage, makeAsset } from '../images';
import { createRoomSurfaces, validateRoomDimensions } from '../room-geometry';
import { renderRoomBackground } from '../room-background';
import {
  prepareReconstructionTargetFrame,
  type ReconstructionTargetFrame,
} from './reconstruction-target-frame';
import { createRoomPlacement, projectRoomFixture } from '../room-fixtures';
import { segmentRoom, type RoomSegmentation } from '../segmentation';
import { runQualityPipeline, photoFingerprint } from './quality-core';
import type { ReconstructionAnalysisProfile } from './quality-contract';
import { withProjectAnalysisDiagnostics } from './project-diagnostics';
import { LAB_BASELINE_REVISION } from './lab-engine';
import { renderReconstructionTemplate, TEMPLATE_RENDERER_REVISION } from './templates';
import {
  projectReconstructionFixture,
  fitReconstructionFootprint,
  frontContactToCentre,
  isPlanarReconstruction,
  type FixtureOrientation,
} from './projection';
import { homography, transformPoint } from '../render/math';
import { applyRoomSurfaceBand } from '../room-surface-bands';
import { reviewFromSegmentation } from './analysis';
import { inspectReconstructionCandidateMapping, isAppearancePlane } from './installation';
import { inferToiletLidState } from './toilet-observations';
import {
  reconstructionLabels,
  reconstructionDefaults,
  type ReconstructionStandardOptions,
  type ReconstructionKind,
  type ReconstructionReview,
  type ReconstructionCandidate,
} from './types';
export {
  reconstructionLabels,
  reconstructionCandidateLabel,
  reconstructionDefaults,
  RECONSTRUCTION_DEFAULTS,
} from './types';
export type {
  ReconstructionKind,
  ReconstructionReview,
  ReconstructionCandidate,
  ReconstructionPlane,
} from './types';
export { mapReconstructionCandidate, remapReconstructionCandidates } from './analysis';
export { projectReconstructionFixture } from './projection';
export { inferToiletLidState } from './toilet-observations';

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('공간 재구성을 취소했어요.', 'AbortError');
}
function colorValue(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('모형과 타일 색상은 올바른 색상값이어야 해요.');
  return color.toLowerCase();
}
async function materialCode(input: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return (
    'reconstruction-v1-' +
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
function baseMaterial(): Omit<
  MaterialInput,
  'name' | 'code' | 'category' | 'color' | 'widthMm' | 'heightMm' | 'depthMm'
> {
  return {
    brand: '',
    scope: 'personal',
    description:
      '공간미리에서 직접 제작한 비교 재구성용 기본 모형입니다. 실제 상품이나 실측 복원이 아닙니다.',
    finish: '기본 모형',
    usage: 'both',
    installation: 'floor',

    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 0,
    defaultGroutColor: '#bcb9b1',
    defaultPattern: 'grid',
  };
}
export type ReconstructionFixtureOptions = ReconstructionStandardOptions & {
  kind: ReconstructionKind;
  room: RoomDefinition;
  face?: RoomFace;
  orientation?: FixtureOrientation;
  appearanceAssetId?: string;
  color?: string;
  u?: number;
  v?: number;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  aspect?: number;
  repositories?: RepositoryOperations;
  signal?: AbortSignal;
  /** Required when confirming a link to an existing bath. Never included in immutable material data. */
  relatedFixtures?: readonly FixtureInstance[];
};
export async function createReconstructionFixture(
  options: ReconstructionFixtureOptions,
): Promise<FixtureInstance> {
  checkAbort(options.signal);
  const versionNumber = options.version ?? 2;
  const defaults = {
    ...reconstructionDefaults(
      options.kind,
      options.basinVariant ?? (versionNumber === 1 && options.kind === 'basin' ? 'pedestal' : undefined),
    ),
    ...(options.vanityStyle === 'open-counter' ? openCounterDefaults(options.counterSupport ?? 'wall') : {}),
    ...(options.kind === 'shower' && options.showerVariant
      ? showerVariantDefaults(options.showerVariant)
      : {}),
  };
  if (!defaults || !validateRoomDimensions(options.room))
    throw new Error('기본 모형 종류와 공간 크기를 확인해 주세요.');
  if (options.pedestalShape !== undefined && !['round', 'rectangular'].includes(options.pedestalShape))
    throw new Error('기둥 단면 값을 확인해 주세요.');
  // Explicit undefined is the update path for pre-field documents; new fixtures get an honest default.
  const toiletLidState = Object.hasOwn(options, 'toiletLidState')
    ? options.toiletLidState
    : versionNumber === 2
      ? defaults.toiletLidState
      : undefined;
  const standard: ReconstructionStandardOptions = {
    version: versionNumber,
    placementPolicy: options.placementPolicy,
    support: options.support ? structuredClone(options.support) : undefined,
    basinVariant: options.basinVariant ?? defaults.basinVariant,
    basinShape: options.basinShape ?? defaults.basinShape,
    pedestalShape:
      options.kind === 'basin' && (options.basinVariant ?? defaults.basinVariant) === 'pedestal'
        ? options.pedestalShape
        : undefined,
    bowlCount: options.bowlCount ?? (versionNumber === 2 ? defaults.bowlCount : undefined),
    toiletLidState,
    mirrorShape: options.mirrorShape,
    showerVariant: options.showerVariant,
    curtainHardware:
      options.kind === 'showerCurtain' ? (options.curtainHardware ?? defaults.curtainHardware) : undefined,
    vanityStyle: options.vanityStyle,
    counterSupport:
      options.vanityStyle === 'open-counter' ? (options.counterSupport ?? 'wall') : options.counterSupport,
    bathLiningColor:
      options.kind === 'bath' && options.bathLiningColor !== undefined
        ? colorValue(options.bathLiningColor)
        : undefined,
    baseHeightMm: options.baseHeightMm ?? defaults.baseHeightMm,
    yawDegrees: options.yawDegrees ?? defaults.yawDegrees,
    hasFrame: options.hasFrame ?? defaults.hasFrame,
    opacity: options.opacity ?? defaults.opacity,
    doorCount: options.doorCount ?? defaults.doorCount,
    shelfStyle: options.shelfStyle ?? defaults.shelfStyle,
    sourceMaterialVersionId: options.sourceMaterialVersionId,
    colorEvidence: options.colorEvidence ? structuredClone(options.colorEvidence) : undefined,
    provenance: {
      kind: 'user',
      mounting: 'default',
      wall: 'default',
      position: 'default',
      dimensions: 'default',
      shape: 'default',
      bowlCount: 'default',
      appearance: options.colorEvidence?.source ?? 'default',
      color: options.colorEvidence?.source ?? 'default',
      ...options.provenance,
      ...(options.showerVariant ? { showerVariant: options.provenance?.showerVariant ?? 'default' } : {}),
      ...(options.kind === 'showerCurtain'
        ? { curtainHardware: options.provenance?.curtainHardware ?? 'default' }
        : {}),
      ...(options.mirrorShape ? { mirrorShape: options.provenance?.mirrorShape ?? 'default' } : {}),
      ...(options.vanityStyle ? { vanityStyle: options.provenance?.vanityStyle ?? 'default' } : {}),
      ...(options.vanityStyle === 'open-counter'
        ? { counterSupport: options.provenance?.counterSupport ?? 'default' }
        : {}),
      ...(options.kind === 'bath' && options.bathLiningColor !== undefined
        ? { bathLiningColor: options.provenance?.bathLiningColor ?? 'default' }
        : {}),
      ...(toiletLidState ? { toiletLidState: options.provenance?.toiletLidState ?? 'default' } : {}),
    },
  };
  if (options.kind !== 'showerCurtain') delete standard.provenance?.curtainHardware;
  if (
    options.kind === 'showerCurtain' &&
    (versionNumber !== 2 ||
      (options.face ?? defaults.face) !== 'floor' ||
      (options.depthMm ?? defaults.depthMm) <= 0)
  )
    throw new Error('샤워 커튼은 바닥 좌표 기준의 매달림 모형이며 전체 깊이는 0보다 커야 해요.');
  if (standard.curtainHardware !== undefined && !['rod', 'track', 'none'].includes(standard.curtainHardware))
    throw new Error('커튼 지지 방식은 봉·레일·표시 안 함 중 선택해 주세요.');
  const params = {
    ...standard,
    kind: options.kind,
    appearanceAssetId:
      versionNumber === 1 && (options.kind === 'mirror' || options.kind === 'window')
        ? options.appearanceAssetId
        : undefined,
    color: colorValue(options.color ?? defaults.color),
    room: options.room,
    face: options.face ?? defaults.face,
    orientation: options.orientation ?? (options.face && options.face !== 'floor' ? options.face : 'back'),
    u: options.u ?? 0.5,
    v: options.v ?? (defaults.face === 'floor' ? 0.2 : options.kind === 'door' ? 1 : 0.5),
    widthMm: options.widthMm ?? defaults.widthMm,
    heightMm: options.heightMm ?? defaults.heightMm,
    depthMm: options.depthMm ?? defaults.depthMm,
    aspect: options.aspect ?? 4096 / 2731,
  };
  const variantErrors = fixtureVariantErrors(params);
  if (variantErrors.length) throw new Error(variantErrors.join(' '));
  if (options.placementPolicy === 'preserve' && versionNumber === 2 && params.face !== 'floor') {
    // Convert only a missing coordinate. Explicit height and v must agree, not overwrite each other.
    params.baseHeightMm =
      options.baseHeightMm ??
      (options.v !== undefined ? (1 - options.v) * params.room.heightMm : standard.baseHeightMm);
    if (options.v === undefined && params.baseHeightMm !== undefined)
      params.v = 1 - params.baseHeightMm / params.room.heightMm;
  }
  if (options.placementPolicy === 'preserve' && !hasParentGlassSupport(params.support)) {
    const review = inspectStrictPlacement(params.room, params);
    if (review.status === 'held') throw new StrictPlacementError(review);
  }
  if (
    [params.widthMm, params.heightMm, params.depthMm].some(
      (n) => !Number.isFinite(n) || n <= 0 || n > 20000,
    ) ||
    [params.u, params.v].some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    !['floor', 'left', 'back', 'right'].includes(params.face) ||
    (params.baseHeightMm !== undefined &&
      (!Number.isFinite(params.baseHeightMm) ||
        params.baseHeightMm < 0 ||
        params.baseHeightMm > options.room.heightMm)) ||
    (params.yawDegrees !== undefined && !Number.isFinite(params.yawDegrees)) ||
    (params.opacity !== undefined &&
      (!Number.isFinite(params.opacity) || params.opacity < 0 || params.opacity > 1)) ||
    (params.doorCount !== undefined &&
      (!Number.isInteger(params.doorCount) || params.doorCount < 1 || params.doorCount > 6)) ||
    (params.basinVariant !== undefined && !['wall', 'pedestal', 'vanity'].includes(params.basinVariant)) ||
    (params.basinShape !== undefined && !['rectangular', 'round'].includes(params.basinShape)) ||
    (params.bowlCount !== undefined && params.bowlCount !== 1 && params.bowlCount !== 2) ||
    (params.toiletLidState !== undefined && !['open', 'closed'].includes(params.toiletLidState)) ||
    (params.provenance?.toiletLidState !== undefined &&
      !['default', 'inferred', 'user'].includes(params.provenance.toiletLidState)) ||
    (params.shelfStyle !== undefined && !['solid', 'rack'].includes(params.shelfStyle))
  )
    throw new Error('모형 규격은 1–20,000mm, 면 위치는 0–100% 범위로 입력해 주세요.');
  if (hasParentGlassSupport(params.support)) {
    const result = resolveBathRimPlacement(params.room, options.relatedFixtures ?? [], params);
    if (result.status !== 'attached') {
      const reason = result.status === 'held' ? result.reason : '욕조를 선택해 주세요.';
      if (options.placementPolicy === 'preserve') {
        const review = inspectStrictPlacement(params.room, params);
        review.status = 'held';
        review.reasons = [...new Set([...review.reasons, reason])];
        throw new StrictPlacementError(review);
      }
      throw new Error(reason);
    }
    Object.assign(params, {
      u: result.placement.u,
      v: result.placement.v,
      baseHeightMm: result.placement.baseHeightMm,
      yawDegrees: result.placement.yawDegrees,
      support: result.placement.support,
    });
    Object.assign(standard, {
      baseHeightMm: params.baseHeightMm,
      yawDegrees: params.yawDegrees,
      support: params.support,
    });
  }
  if (params.support || params.kind === 'showerCurtain') {
    // An explicit support must fit as entered. Never shrink/move it to conceal an invalid height.
    const check = validateSourceFixture(params.room, undefined, params);
    if (!check.valid) {
      if (options.placementPolicy === 'preserve')
        throw new StrictPlacementError(inspectStrictPlacement(params.room, params));
      throw new Error(check.reasons.join(' '));
    }
  }
  if (options.placementPolicy === 'preserve') {
    const review = inspectStrictPlacement(params.room, params);
    if (review.status === 'held') throw new StrictPlacementError(review);
  } else if (versionNumber === 2 && params.face !== 'floor') {
    const availableWidth = params.face === 'back' ? params.room.widthMm : params.room.depthMm;
    const scale = Math.min(1, availableWidth / params.widthMm, params.room.heightMm / params.heightMm);
    params.widthMm *= scale;
    params.heightMm *= scale;
    params.depthMm *= scale;
    const halfU = params.widthMm / availableWidth / 2;
    params.u = Math.max(halfU, Math.min(1 - halfU, params.u));
    params.baseHeightMm = Math.max(
      0,
      Math.min(
        params.room.heightMm - params.heightMm,
        options.baseHeightMm ??
          (options.v !== undefined
            ? (1 - options.v) * params.room.heightMm
            : (standard.baseHeightMm ?? (1 - params.v) * params.room.heightMm - params.heightMm / 2)),
      ),
    );
    params.v = 1 - params.baseHeightMm / params.room.heightMm;
  } else if (
    params.kind !== 'showerCurtain' &&
    !params.support &&
    !isPlanarReconstruction(params.kind) &&
    params.face === 'floor'
  ) {
    const fitted = fitReconstructionFootprint(params.room, params);
    params.u = fitted.u;
    params.v = fitted.v;
    params.widthMm *= fitted.scale;
    params.heightMm *= fitted.scale;
    params.depthMm *= fitted.scale;
  } else if (isPlanarReconstruction(params.kind) && params.face !== 'floor') {
    const width = params.face === 'back' ? params.room.widthMm : params.room.depthMm;
    const scale = Math.min(1, width / params.widthMm, params.room.heightMm / params.heightMm);
    params.widthMm *= scale;
    params.heightMm *= scale;
    const halfU = params.widthMm / width / 2;
    params.u = Math.max(halfU, Math.min(1 - halfU, params.u));
    const anchorY = params.kind === 'door' ? 1 : 0.5;
    const extent = params.heightMm / params.room.heightMm;
    params.v = Math.max(extent * anchorY, Math.min(1 - extent * (1 - anchorY), params.v));
  }
  const repos = options.repositories ?? getRepositories(),
    code = await materialCode({ templateRevision: TEMPLATE_RENDERER_REVISION, ...params });
  checkAbort(options.signal);
  let version = (await repos.materials.list()).find(
    ({ version }) => version.reconstruction?.version === versionNumber && version.code === code,
  )?.version;
  checkAbort(options.signal);
  if (!version) {
    const rendered = params.appearanceAssetId ? undefined : await renderReconstructionTemplate(params);
    checkAbort(options.signal);
    const asset = params.appearanceAssetId
      ? await repos.assets.get(params.appearanceAssetId)
      : await makeAsset(rendered!.blob, `${reconstructionLabels[params.kind]} 기본 모형.png`, 'product');
    checkAbort(options.signal);
    if (!params.appearanceAssetId) await repos.assets.put(asset);
    checkAbort(options.signal);
    version = await createProjectMaterial(repos, {
      ...baseMaterial(),
      name: `${reconstructionLabels[params.kind]} · 재구성 모형`,
      code,
      category: params.kind,
      color: params.color,
      widthMm: params.widthMm,
      heightMm: params.heightMm,
      depthMm: params.depthMm,
      installation:
        params.kind === 'showerCurtain' ? 'suspended' : params.face === 'floor' ? 'floor' : 'wall',

      views: [
        { assetId: asset.id, direction: '공간 공통 카메라', anchor: rendered?.anchor ?? { x: 0.5, y: 0.5 } },
      ],
      reconstruction: { version: versionNumber, kind: params.kind },
    });
  }
  checkAbort(options.signal);
  const asset = await repos.assets.get(version.views[0].assetId);
  const placement = await createRoomPlacement(version, asset, params.face);
  checkAbort(options.signal);
  Object.assign(placement, { u: params.u, v: params.v });
  const fixture: FixtureInstance = {
    id: crypto.randomUUID(),
    name: `${reconstructionLabels[params.kind]} · 기본 모형`,
    materialVersionId: version.id,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.1,
    height: 0.1,
    rotation: 0,
    anchor: { ...version.views[0].anchor },
    locked: false,
    roomPlacement: placement,
    shadow: {
      x: 0,
      y: 0,
      opacity: params.kind === 'glassPartition' ? 0 : params.face === 'floor' ? 0.16 : 0.025,
      blur: 0.008,
      scale: 1,
    },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      ...standard,
      baseHeightMm: params.baseHeightMm,
      kind: params.kind,
      orientation: params.orientation,
      appearanceAssetId: params.appearanceAssetId,
      color: params.color,
      widthMm: params.widthMm,
      heightMm: params.heightMm,
      depthMm: params.depthMm,
      version: versionNumber,
    },
  };
  projectRoomFixture(params.room, fixture, params.aspect);
  projectReconstructionFixture(params.room, fixture, params.aspect);
  return fixture;
}
export async function updateReconstructionFixture(
  fixture: FixtureInstance,
  room: RoomDefinition,
  patch: Partial<
    Pick<
      ReconstructionFixtureOptions,
      | 'kind'
      | 'color'
      | 'widthMm'
      | 'heightMm'
      | 'depthMm'
      | 'face'
      | 'u'
      | 'v'
      | 'orientation'
      | keyof ReconstructionStandardOptions
    >
  >,
  options: Pick<
    ReconstructionFixtureOptions,
    'aspect' | 'repositories' | 'signal' | 'relatedFixtures' | 'placementPolicy'
  > & {
    convertToStandard?: boolean;
  } = {},
): Promise<FixtureInstance> {
  const meta = fixture.reconstruction,
    placement = fixture.roomPlacement;
  if (!meta || !placement) throw new Error('재구성 기본 모형을 선택해 주세요.');
  const conversion = options.convertToStandard && meta.version === 1;
  const wallBottom =
    placement.face === 'floor'
      ? meta.baseHeightMm
      : (meta.baseHeightMm ??
        Math.max(
          0,
          (1 - placement.v) * room.heightMm -
            (meta.kind === 'door' ? 0 : (meta.heightMm * placement.scale) / 2),
        ));
  const next = await createReconstructionFixture({
    ...meta,
    toiletLidState: meta.toiletLidState,
    // Preserve the historical implicit double-bowl vanity while editing old immutable versions.
    ...(meta.bowlCount === undefined && (meta.kind === 'vanity' || meta.basinVariant === 'vanity')
      ? { bowlCount: (meta.widthMm >= 1000 ? 2 : 1) as 1 | 2 }
      : {}),
    version: options.convertToStandard ? 2 : meta.version,
    ...(conversion
      ? {
          sourceMaterialVersionId: meta.sourceMaterialVersionId ?? fixture.materialVersionId,
          baseHeightMm: wallBottom,
          widthMm: meta.widthMm * placement.scale,
          heightMm: meta.heightMm * placement.scale,
          depthMm: meta.depthMm * placement.scale,
          basinVariant: meta.kind === 'basin' ? ('pedestal' as const) : meta.basinVariant,
        }
      : {}),
    kind: meta.kind as ReconstructionKind,
    room,
    face: placement.face,
    u: placement.u,
    v: placement.v,
    ...patch,
    ...(meta.version === 2 &&
    patch.v !== undefined &&
    patch.baseHeightMm === undefined &&
    (patch.face ?? placement.face) !== 'floor'
      ? { baseHeightMm: (1 - patch.v) * room.heightMm }
      : {}),
    ...(meta.version === 2 &&
    patch.baseHeightMm !== undefined &&
    patch.v === undefined &&
    (patch.face ?? placement.face) !== 'floor'
      ? { v: 1 - patch.baseHeightMm / room.heightMm }
      : {}),
    appearanceAssetId: patch.kind && patch.kind !== meta.kind ? undefined : meta.appearanceAssetId,
    ...options,
  });
  next.id = fixture.id;
  next.name = patch.kind && patch.kind !== meta.kind ? next.name : fixture.name;
  next.locked = fixture.locked;
  next.rotation = fixture.rotation;
  next.occlusion = structuredClone(fixture.occlusion);
  next.shadow = { ...fixture.shadow };
  next.color = { ...fixture.color };
  next.roomPlacement!.scale = conversion ? 1 : placement.scale;
  if (next.reconstruction?.placementPolicy === 'preserve') {
    const review = inspectStrictPlacement(room, {
      ...next.reconstruction,
      ...next.roomPlacement!,
      kind: next.reconstruction.kind as ReconstructionKind,
      depthMm: next.reconstruction.depthMm,
    });
    if (review.status === 'held') throw new StrictPlacementError(review);
  }
  projectRoomFixture(room, next, options.aspect ?? 4096 / 2731);
  projectReconstructionFixture(room, next, options.aspect ?? 4096 / 2731);
  return next;
}
export async function createReconstructionTile(options: {
  color: string;
  kind: 'floor' | 'wall';
  widthMm?: number;
  heightMm?: number;
  groutWidth?: number;
  groutColor?: string;
  pattern?: 'grid' | 'brick';
  repositories?: RepositoryOperations;
  signal?: AbortSignal;
}): Promise<MaterialVersion> {
  const color = colorValue(options.color),
    widthMm = options.widthMm ?? 300,
    heightMm = options.heightMm ?? (options.kind === 'floor' ? 300 : 600),
    grout = options.groutWidth ?? 0;
  if (
    [widthMm, heightMm].some((n) => !Number.isFinite(n) || n < 10 || n > 20000) ||
    !Number.isFinite(grout) ||
    grout < 0 ||
    grout > 30
  )
    throw new Error('타일 규격과 줄눈 두께를 확인해 주세요.');
  const repos = options.repositories ?? getRepositories(),
    code = await materialCode({
      kind: options.kind,
      color,
      widthMm,
      heightMm,
      grout,
      groutColor: options.groutColor,
      pattern: options.pattern ?? 'grid',
    });
  checkAbort(options.signal);
  const existing = (await repos.materials.list()).find(
    ({ version }) => version.reconstruction?.kind === 'tile' && version.code === code,
  )?.version;
  if (existing) return existing;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 16, 16);
  const asset = await makeAsset(await canvasBlob(canvas), '기존 타일 대표색.png', 'texture');
  checkAbort(options.signal);
  await repos.assets.put(asset);
  checkAbort(options.signal);
  return createProjectMaterial(repos, {
    ...baseMaterial(),
    name: `기존 ${options.kind === 'floor' ? '바닥' : '벽'} 타일 · 추정`,
    category: 'tile',
    code,
    color,
    widthMm,
    heightMm,
    depthMm: 10,

    textureAssetIds: [asset.id],
    defaultPattern: options.pattern ?? 'grid',
    defaultGroutWidth: grout,
    defaultGroutColor: options.groutColor ?? '#bcb9b1',
    reconstruction: { version: 1, kind: 'tile' },
  });
}
const physicalRanges: Record<
  ReconstructionKind,
  { width: [number, number]; height: [number, number]; depth: [number, number] }
> = {
  toilet: { width: [300, 650], height: [500, 1000], depth: [500, 900] },
  basin: { width: [350, 1000], height: [550, 1100], depth: [300, 700] },
  vanity: { width: [650, 2400], height: [650, 1050], depth: [350, 800] },
  bath: { width: [1000, 2300], height: [400, 800], depth: [550, 1100] },
  mirror: { width: [200, 2000], height: [250, 2000], depth: [10, 80] },
  door: { width: [500, 1400], height: [1600, 2600], depth: [30, 120] },
  window: { width: [250, 2400], height: [250, 2200], depth: [40, 180] },
  glassPartition: { width: [300, 1800], height: [600, 2400], depth: [4, 30] },
  mirrorCabinet: { width: [300, 2200], height: [300, 1800], depth: [80, 350] },
  wallShelf: { width: [150, 1600], height: [10, 200], depth: [80, 500] },
  shower: { width: [100, 1000], height: [500, 2200], depth: [60, 600] },
  wallCabinet: { width: [200, 2400], height: [200, 1500], depth: [80, 650] },
  lowPartition: { width: [200, 2400], height: [100, 1800], depth: [40, 600] },
  showerCurtain: { width: [200, 2400], height: [400, 2600], depth: [10, 120] },
};
export function estimateCandidateFixture(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
  room: RoomDefinition,
  placement: { face: RoomFace; u: number; v: number },
): Required<
  Pick<
    ReconstructionFixtureOptions,
    | 'widthMm'
    | 'heightMm'
    | 'depthMm'
    | 'orientation'
    | 'u'
    | 'v'
    | 'baseHeightMm'
    | 'color'
    | 'colorEvidence'
    | 'provenance'
  >
> &
  Pick<
    ReconstructionFixtureOptions,
    'basinVariant' | 'basinShape' | 'bowlCount' | 'toiletLidState' | 'bathLiningColor'
  > {
  const basinVariant =
    candidate.installation?.basinVariant ??
    (candidate.kind === 'basin' && placement.face !== 'floor' ? 'wall' : undefined);
  const defaults = reconstructionDefaults(candidate.kind, basinVariant),
    range =
      candidate.kind === 'basin' && basinVariant === 'wall'
        ? { ...physicalRanges.basin, height: [120, 300] as [number, number] }
        : physicalRanges[candidate.kind];
  const plane =
    placement.face === 'floor'
      ? review.planes.find(
          (p) =>
            p.face !== 'floor' &&
            p.face === candidate.installation?.wall &&
            (candidate.installation.source === 'user' || !isAppearancePlane(p) || p.confirmed),
        )
      : review.planes.find((p) => p.face === placement.face);
  const geometryKnown = !!plane && (!isAppearancePlane(plane) || plane.confirmed);
  const orientation: FixtureOrientation =
    candidate.installation?.source === 'user' && candidate.installation.wall
      ? candidate.installation.wall
      : plane?.face && plane.face !== 'floor'
        ? plane.face
        : 'back';
  // A wall homography measures points on that wall, not a freestanding body's visible box.
  // The baseline has no calibrated volume-size observation; category sizes remain editable defaults.
  const categoryDimensions = placement.face === 'floor' || candidate.kind === 'basin';
  let width = defaults.widthMm,
    height = defaults.heightMm;
  if (plane && geometryKnown && !categoryDimensions)
    try {
      const inverse = homography(plane.quad);
      const b = candidate.bounds;
      const corners = [
        { x: b.left, y: b.top },
        { x: b.right, y: b.top },
        { x: b.right, y: b.bottom },
        { x: b.left, y: b.bottom },
      ].map((p) => transformPoint(inverse, p));
      const dx = Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x));
      const dy = Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y));
      width =
        dx *
        (plane.face === 'back'
          ? room.widthMm * ((plane.horizontalEnd ?? 1) - (plane.horizontalStart ?? 0))
          : room.depthMm * (plane.depthEnd - plane.depthStart));
      height = dy * room.heightMm * ((plane.verticalEnd ?? 1) - (plane.verticalStart ?? 0));
    } catch {
      /* Keep honest category estimates when the source perspective is unusable. */
    }
  const bounded = (n: number, limits: [number, number]) =>
    Math.round(Math.max(limits[0], Math.min(limits[1], n)) / 10) * 10;
  width = bounded(width, range.width);
  height = bounded(height, range.height);
  let depth = bounded(
    defaults.depthMm * Math.min(1.3, Math.max(0.75, width / defaults.widthMm)),
    range.depth,
  );
  // A basin bounding box mixes bowl, faucet and perspective; it is not a calibrated product measurement.
  // Keep an honest, editable default instead of stretching a wall basin to an uncertain source wall.
  if (categoryDimensions) {
    width = defaults.widthMm;
    height = defaults.heightMm;
    depth = defaults.depthMm;
  }
  // The observed bottom contour is the visible front contact, while rendering uses footprint centre.
  const { u, v: initialV } = frontContactToCentre(room, placement, depth, orientation);
  let v = initialV;
  // Keep the requested estimate; bounds validation holds it instead of moving/shrinking it.
  const baseHeightMm =
    placement.face === 'floor'
      ? 0
      : !geometryKnown
        ? (defaults.baseHeightMm ?? (candidate.kind === 'door' ? 0 : 1200))
        : (1 - placement.v) * room.heightMm -
          (candidate.kind === 'door' || basinVariant === 'wall' || candidate.kind === 'wallShelf'
            ? 0
            : height / 2);
  if (placement.face !== 'floor') v = 1 - baseHeightMm / room.heightMm;
  const lidObservation = inferToiletLidState(candidate);
  const colorEvidence = resolveProductColor(candidate.kind, candidate);
  return {
    color: colorEvidence.color,
    colorEvidence,
    widthMm: width,
    heightMm: height,
    depthMm: depth,
    orientation,
    u,
    v,
    baseHeightMm,
    basinVariant,
    basinShape: candidate.evidence.basinShape?.value ?? defaults.basinShape,
    bowlCount: candidate.evidence.bowlCount?.value ?? defaults.bowlCount,
    toiletLidState: lidObservation?.value ?? defaults.toiletLidState,
    ...(candidate.kind === 'bath' ? { bathLiningColor: '#eeefeb' } : {}),
    provenance: {
      kind: candidate.proposedKind ? 'inferred' : 'model',
      mounting: candidate.installation?.source ?? 'inferred',
      wall: candidate.installation?.source === 'user' ? 'user' : geometryKnown ? 'inferred' : 'default',
      position: placement.face !== 'floor' && !geometryKnown ? 'default' : 'inferred',
      dimensions: !geometryKnown || categoryDimensions ? 'default' : 'inferred',
      width: !geometryKnown || categoryDimensions ? 'default' : 'inferred',
      height: !geometryKnown || categoryDimensions ? 'default' : 'inferred',
      depth: !geometryKnown || categoryDimensions ? 'default' : 'inferred',
      shape: candidate.evidence.basinShape ? 'inferred' : 'default',
      bowlCount: candidate.evidence.bowlCount ? 'inferred' : 'default',
      ...(candidate.kind === 'toilet' ? { toiletLidState: lidObservation?.source ?? 'default' } : {}),
      ...(candidate.kind === 'bath' ? { bathLiningColor: 'default' } : {}),
      appearance: colorEvidence.source,
      color: colorEvidence.source,
    },
  };
}
export type ReconstructionProjectOptions = {
  /** Administrator edits must not retain another owner's photo-derived observations locally. */
  cachePolicy?: AnalysisCachePolicy;
  onDiagnostic?: (entry: import('./lab-diagnostic-storage').DiagnosticArchiveEntry) => void;
  repositories?: RepositoryOperations;
  onStage?: (message: string) => void;
  signal?: AbortSignal;
  manual?: boolean;
  onAnalysis?: (size: { width: number; height: number }) => void;
  onRawReview?: (review: ReconstructionReview) => void;
  onBaselineAnalysis?: (measurement: { elapsedMs: number; reused: boolean }) => void;
  onSegmentationCandidates?: (candidates: ReconstructionCandidate[]) => void;
  analysisProfile?: ReconstructionAnalysisProfile;
  mogeMode?: import('./moge-browser/client').MogeExecutionMode;
  onMogeGeometry?: (result: import('./moge-browser/client').MogeBrowserResult) => void;
  /** Reanalysis only: preserve the existing Before/After pixel frame and camera aspect. */
  targetFrame?: ReconstructionTargetFrame;
  /** Lab owns its encompassing render/diagnostic lifecycle. */
  externalDiagnostics?: boolean;
  onQuality?: (result: Awaited<ReturnType<typeof runQualityPipeline>>) => void;
  onQualityCheckpoint?: (name: string, value: unknown) => void;
  onAnalysisPhase?: (phase: import('./lab-diagnostics').DiagnosticPhase) => void;
  /** Explicit replay/hook; ordinary creation uses the same quality core. */
  reuseAnalysis?: ReconstructionReview;
  transformAnalysis?: (
    review: ReconstructionReview,
    photo: Blob,
    image: { width: number; height: number },
    segmentation?: RoomSegmentation,
  ) => Promise<{ review: ReconstructionReview; plans: Record<string, CandidateFixturePlan | null> }>;
};
export async function createReconstructionProject(
  file: File,
  room: RoomDefinition,
  options: ReconstructionProjectOptions = {},
): Promise<ProjectDocument> {
  options = { ...options, signal: photoAnalysisSignal(options.signal, options.cachePolicy ?? 'persistent') };
  if (options.externalDiagnostics) return createReconstructionProjectImpl(file, room, options);
  const profile = options.manual ? 'browser-basic' : (options.analysisProfile ?? 'browser-basic');
  return withProjectAnalysisDiagnostics(
    file,
    room,
    profile,
    options.signal,
    (capture, diagnostic) =>
      createReconstructionProjectImpl(file, room, {
        ...options,
        onStage: (message) => {
          diagnostic.progress(message);
          options.onStage?.(message);
        },
        onAnalysisPhase: (phase) => {
          diagnostic.phase(phase);
          options.onAnalysisPhase?.(phase);
        },
        onQualityCheckpoint: (name, value) => {
          diagnostic.checkpoint(name, value);
          options.onQualityCheckpoint?.(name, value);
        },
        onRawReview: (review) => {
          capture.rawReview = structuredClone(review);
          diagnostic.checkpoint('baselineReview', review);
          options.onRawReview?.(review);
        },
        onSegmentationCandidates: (candidates) => {
          capture.rawSegmentationCandidates = structuredClone(candidates);
          diagnostic.checkpoint('rawSegmentationCandidates', candidates);
          options.onSegmentationCandidates?.(candidates);
        },
        onQuality: (result) => {
          capture.quality = result.evidence;
          capture.pipeline = {
            ...result.pipeline,
            model: result.model,
            modelReused: result.evidence.reused,
            quality: result.evidence,
          };
          diagnostic.checkpoint('candidatePipeline', capture.pipeline);
          options.onQuality?.(result);
        },
        onBaselineAnalysis: (measurement) => {
          diagnostic.checkpoint('baselineMeasurement', measurement);
          diagnostic.phase(profile !== 'browser-basic' ? 'candidate-model' : 'placement');
          options.onBaselineAnalysis?.(measurement);
        },
      }),
    options.onDiagnostic,
  );
}
async function createReconstructionProjectImpl(
  file: File,
  room: RoomDefinition,
  options: ReconstructionProjectOptions,
): Promise<ProjectDocument> {
  if (!validateRoomDimensions(room)) throw new Error('공간 크기를 확인해 주세요.');
  const repos = options.repositories ?? getRepositories();
  checkAbort(options.signal);
  let targetBackground: Awaited<ReturnType<typeof prepareReconstructionTargetFrame>> | undefined;
  if (options.targetFrame) {
    options.onStage?.('기존 비교 화면 크기 유지 가능 여부 확인 중');
    targetBackground = await prepareReconstructionTargetFrame(room, options.targetFrame);
    checkAbort(options.signal);
  }
  options.onStage?.('참고 사진의 형식과 크기 확인 중');
  const reference = await importImage(file, 'original', repos.assets);
  checkAbort(options.signal);
  if (options.onQualityCheckpoint) {
    options.onQualityCheckpoint('photoInput', {
      originalFingerprint: await photoFingerprint(reference.original.blob),
      normalizedFingerprint: await photoFingerprint(reference.preview.blob),
      originalImage: { width: reference.original.width, height: reference.original.height },
      normalizedImage: { width: reference.preview.width, height: reference.preview.height },
      normalization: 'importImage orientation-normalized full-frame preview',
    });
    checkAbort(options.signal);
  }
  let review: ReconstructionReview = {
    version: 2,
    analysis: 'manual',
    planes: [],
    candidates: [],
    warnings: ['직접 구성 모드예요. 원본 사진을 보면서 기존 타일과 기구를 추가해 주세요.'],
  };
  options.onAnalysisPhase?.('baseline');
  let segmentationCapture: RoomSegmentation | undefined;
  const baselineAnalysisStarted = performance.now();
  if (options.reuseAnalysis) {
    review = structuredClone(options.reuseAnalysis);
  } else if (!options.manual) {
    const runSegmentation =
      options.analysisProfile === 'cloud-browser-v1'
        ? async (
            photo: Blob,
            onStage: ((message: string) => void) | undefined,
            settings: { signal?: AbortSignal },
          ) =>
            (await import('./segmentation-cache')).segmentReconstructionCached(
              photo,
              onStage,
              settings.signal ?? new AbortController().signal,
            )
        : segmentRoom;
    const segmentation = await runSegmentation(
      reference.preview.blob,
      (message) => {
        if (!options.signal?.aborted) options.onStage?.(message);
      },
      { quality: 'reconstruction', signal: options.signal },
    );
    checkAbort(options.signal);
    segmentationCapture = segmentation;
    options.onAnalysis?.({ width: segmentation.width, height: segmentation.height });
    options.onSegmentationCandidates?.(structuredClone(segmentation.objects ?? []));
    const bitmap = await createImageBitmap(reference.preview.blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = segmentation.width;
      canvas.height = segmentation.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('참고 사진의 색상을 읽을 수 없어요.');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      review = reviewFromSegmentation(
        segmentation,
        ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        room,
      );
    } finally {
      bitmap.close();
    }
  }
  options.onBaselineAnalysis?.({
    elapsedMs: options.reuseAnalysis || options.manual ? 0 : performance.now() - baselineAnalysisStarted,
    reused: !!options.reuseAnalysis,
  });
  options.onRawReview?.(structuredClone(review));
  let candidatePlans: Record<string, CandidateFixturePlan | null> | undefined;
  if (options.transformAnalysis) {
    const transformed = await options.transformAnalysis(
      structuredClone(review),
      reference.preview.blob,
      {
        width: reference.preview.width,
        height: reference.preview.height,
      },
      segmentationCapture,
    );
    checkAbort(options.signal);
    review = transformed.review;
    candidatePlans = transformed.plans;
  } else if (!options.manual && options.analysisProfile === 'local-quality-v1') {
    throw new Error('기존 로컬 AI 분석은 종료됐어요. 사진 분석 방식에서 AI 정밀 분석을 다시 선택해 주세요.');
  } else if (!options.manual && options.analysisProfile === 'cloud-browser-v1') {
    const runQuality = async (input: Parameters<typeof runQualityPipeline>[0]) =>
      (await import('./cloud-quality')).runCloudBrowserQuality(input, {
        mode: options.mogeMode,
        onGeometry: options.onMogeGeometry,
      });
    const result = await runQuality({
      baseline: structuredClone(review),
      photo: reference.preview.blob,
      image: { width: reference.preview.width, height: reference.preview.height },
      room,
      inputFingerprint: await photoFingerprint(reference.original.blob),
      segmentation: segmentationCapture,
      signal: options.signal ?? new AbortController().signal,
      onStage: options.onStage,
      onCheckpoint: options.onQualityCheckpoint,
      onPhase: options.onAnalysisPhase,
    });
    checkAbort(options.signal);
    review = result.review;
    candidatePlans = result.plans;
    options.onQuality?.(result);
  }
  review.analysisProfile ??= 'browser-basic';
  review.analysisSummary ??= {
    profile: review.analysisProfile,
    revision: LAB_BASELINE_REVISION,
    estimated: true,
  };
  checkAbort(options.signal);
  options.onAnalysisPhase?.('render');
  options.onStage?.('같은 구도의 비교 공간 생성 중');
  const background = targetBackground ?? (await renderRoomBackground(room));
  checkAbort(options.signal);
  const generated = await importImage(
    new File([background.blob], '비교 공간 배경.png', { type: 'image/png' }),
    'original',
    repos.assets,
  );
  checkAbort(options.signal);
  const scene: Scene = {
    originalAssetId: generated.original.id,
    previewAssetId: generated.preview.id,
    imageWidth: generated.original.width,
    imageHeight: generated.original.height,
    room: structuredClone(room),
    surfaces: createRoomSurfaces(room, generated.original.width / generated.original.height),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  const before = structuredClone(scene);
  for (const plane of review.planes) {
    checkAbort(options.signal);
    const surface = before.surfaces.find((s) => s.roomFace === plane.face);
    if (!surface) continue;
    const bands = surface.kind === 'wall' && plane.bands?.length ? plane.bands : undefined;
    const parts = bands ?? [{ from: 0, to: 1, tile: plane.tile }];
    const replacements = [];
    for (const [index, band] of parts.entries()) {
      const material = await createReconstructionTile({
        ...band.tile,
        kind: surface.kind,
        repositories: repos,
        signal: options.signal,
      });
      const part = structuredClone(surface);
      if (index > 0) part.id = crypto.randomUUID();
      part.materialVersionId = material.id;
      part.tile.pattern = band.tile.pattern ?? 'grid';
      part.tile.groutWidth = band.tile.groutWidth;
      part.tile.groutColor = band.tile.groutColor ?? material.defaultGroutColor;
      part.tile.shading = 0.4;
      if (bands) {
        const top = plane.verticalStart ?? 0,
          bottom = plane.verticalEnd ?? 1;
        const from = index === 0 ? 0 : top + band.from * (bottom - top);
        const to = index === parts.length - 1 ? 1 : top + band.to * (bottom - top);
        part.name =
          surface.name +
          ' ' +
          (index === 0 ? '상부' : index === parts.length - 1 ? '하부' : String(index + 1) + '구간');
        replacements.push(applyRoomSurfaceBand(part, { from, to }));
      } else replacements.push(part);
    }
    before.surfaces.splice(before.surfaces.indexOf(surface), 1, ...replacements);
  }
  const aspect = scene.imageWidth / scene.imageHeight;
  const creationOrder =
    candidatePlans &&
    Object.values(candidatePlans).some((plan) => plan?.bathRimCandidate || plan?.partitionTopCandidate)
      ? [...review.candidates].sort(
          (a, b) =>
            Number(b.kind === 'bath' || b.kind === 'lowPartition') -
            Number(a.kind === 'bath' || a.kind === 'lowPartition'),
        )
      : review.candidates;
  for (const candidate of creationOrder) {
    checkAbort(options.signal);
    const customPlan = candidatePlans?.[candidate.id];
    const mapping = candidatePlans ? undefined : inspectReconstructionCandidateMapping(candidate, review);
    const placement = candidatePlans ? (customPlan ?? undefined) : mapping?.placement;
    if (!placement && mapping?.provisionalPlacement) {
      const provisional = mapping.provisionalPlacement;
      const estimate = estimateCandidateFixture(candidate, review, room, provisional);
      const diagnostic = inspectStrictPlacement(room, {
        kind: candidate.kind,
        ...provisional,
        ...estimate,
        provenance: { ...estimate.provenance, position: 'default' },
      });
      candidate.placementReview = {
        ...diagnostic,
        status: 'held',
        reasons: [...mapping.reasons, ...diagnostic.reasons],
      };
      candidate.requiresReview = true;
      candidate.status = 'unplaced';
      delete candidate.fixtureId;
      candidate.warning = candidate.placementReview.reasons.join(' ');
    }
    if (!placement) {
      if (!candidate.requiresReview)
        candidate.warning = `${reconstructionLabels[candidate.kind]}는 찾았지만 ${mapping?.reasons.join(' ') || candidate.installation?.reason || '설치 위치 확인이 필요해요.'}`;
      candidate.trace = [
        ...(candidate.trace ?? []),
        {
          stage: 'placement',
          outcome: 'held',
          reason: candidate.warning ?? '종류와 설치 위치를 확인해 주세요.',
        },
      ];
      continue;
    }
    if (mapping?.placement)
      candidate.trace = [
        ...(candidate.trace ?? []),
        { stage: 'placement', outcome: 'accepted', reason: mapping.reasons.join(' ') },
      ];
    const bathLink = customPlan?.bathRimCandidate;
    const partitionLink = customPlan?.partitionTopCandidate;
    const parentLink = bathLink ?? partitionLink;
    const parentFixture = parentLink
      ? before.fixtures.find(
          (fixture) =>
            fixture.id ===
            review.candidates.find((item) => item.id === parentLink.parentCandidateId)?.fixtureId,
        )
      : undefined;
    if (
      parentLink &&
      ((bathLink && partitionLink) ||
        !parentFixture ||
        parentFixture.reconstruction?.kind !== (bathLink ? 'bath' : 'lowPartition'))
    ) {
      candidate.requiresReview = true;
      candidate.warning =
        '연결한 부모 후보의 모형이 생성되지 않았거나 종류가 달라요. 원래 지지 입력을 보존하고 유리 배치를 보류해요.';
      candidate.trace = [
        ...(candidate.trace ?? []),
        { stage: 'placement', outcome: 'held', reason: candidate.warning },
      ];
      continue;
    }
    options.onStage?.(`${reconstructionLabels[candidate.kind]} 기본 모형 준비 중`);
    let fixture: FixtureInstance;
    try {
      fixture = await createReconstructionFixture({
        kind: candidate.kind,
        room,
        color: candidate.color,
        ...placement,
        ...(candidatePlans ? customPlan : estimateCandidateFixture(candidate, review, room, placement)),
        ...(parentLink && parentFixture
          ? {
              support: bathLink
                ? bathRimFixtureSupport(bathLink, parentFixture.id, customPlan!.baseHeightMm!)
                : partitionTopFixtureSupport(partitionLink!, parentFixture.id, customPlan!.baseHeightMm!),
              relatedFixtures: before.fixtures,
            }
          : {}),
        aspect,
        repositories: repos,
        signal: options.signal,
        placementPolicy: 'preserve',
      });
    } catch (error) {
      if (!(error instanceof StrictPlacementError)) throw error;
      candidate.placementReview = error.review;
      candidate.requiresReview = true;
      candidate.status = 'unplaced';
      delete candidate.fixtureId;
      candidate.warning = `${reconstructionLabels[candidate.kind]} 배치를 보류했어요. ${error.message} 원래 위치와 규격을 보존했어요.`;
      candidate.trace = [
        ...(candidate.trace ?? []),
        { stage: 'placement', outcome: 'held', reason: candidate.warning },
      ];
      continue;
    }
    candidate.placementReview = inspectStrictPlacement(room, {
      ...fixture.reconstruction!,
      ...fixture.roomPlacement!,
      kind: candidate.kind,
      depthMm: fixture.reconstruction!.depthMm,
    });
    before.fixtures.push(fixture);
    candidate.fixtureId = fixture.id;
    candidate.status = 'placed';
    candidate.trace = [
      ...(candidate.trace ?? []),
      {
        stage: 'model',
        outcome: 'accepted',
        reason:
          '사진 조각을 붙이지 않고 편집 가능한 표준 모형을 생성했어요.' +
          (fixture.reconstruction?.basinShape
            ? ` 볼 형태: ${fixture.reconstruction.basinShape === 'round' ? '곡면' : '사각'} (${fixture.reconstruction.provenance?.shape ?? 'default'}).`
            : '') +
          (fixture.reconstruction?.bowlCount
            ? ` 볼 ${fixture.reconstruction.bowlCount}개 (${fixture.reconstruction.provenance?.bowlCount ?? 'default'}).`
            : '') +
          (fixture.reconstruction?.provenance?.position === 'default'
            ? ' 설치 높이는 관측 영역을 방 전체로 환산하지 않은 수정 가능한 기본값이에요.'
            : ''),
      },
    ];
  }
  checkAbort(options.signal);
  const now = new Date().toISOString();
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: `${file.name.replace(/\.[^.]+$/, '') || '기존 공간'} · 비교`,
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    scene,
    comparison: {
      before,
      room: structuredClone(room),
      cameraVersion: 1,
      aspect,
      referenceOriginalAssetId: reference.original.id,
      referencePreviewAssetId: reference.preview.id,
      status: 'draft',
      review,
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: now,
    updatedAt: now,
  });
}
