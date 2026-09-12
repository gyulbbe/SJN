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
import type { Repositories } from '../repositories';
import { getRepositories } from '../repositories';
import { canvasBlob, importImage, makeAsset } from '../images';
import { createRoomSurfaces, validateRoomDimensions } from '../room-geometry';
import { renderRoomBackground } from '../room-background';
import { createRoomPlacement, projectRoomFixture } from '../room-fixtures';
import { segmentRoom } from '../segmentation';
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
import { createReconstructionAppearance } from './appearance';
import { mapReconstructionCandidate, reviewFromSegmentation } from './analysis';
import {
  reconstructionLabels,
  RECONSTRUCTION_DEFAULTS,
  type ReconstructionKind,
  type ReconstructionReview,
  type ReconstructionCandidate,
  type ReconstructionPlane,
} from './types';
export { reconstructionLabels, RECONSTRUCTION_DEFAULTS } from './types';
export type {
  ReconstructionKind,
  ReconstructionReview,
  ReconstructionCandidate,
  ReconstructionPlane,
} from './types';
export { mapReconstructionCandidate, remapReconstructionCandidates } from './analysis';
export { projectReconstructionFixture } from './projection';

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
export type ReconstructionFixtureOptions = {
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
  repositories?: Repositories;
  signal?: AbortSignal;
};
export async function createReconstructionFixture(
  options: ReconstructionFixtureOptions,
): Promise<FixtureInstance> {
  checkAbort(options.signal);
  const defaults = RECONSTRUCTION_DEFAULTS[options.kind];
  if (!defaults || !validateRoomDimensions(options.room))
    throw new Error('기본 모형 종류와 공간 크기를 확인해 주세요.');
  const params = {
    kind: options.kind,
    appearanceAssetId:
      options.kind === 'mirror' || options.kind === 'window' ? options.appearanceAssetId : undefined,
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
  if (
    [params.widthMm, params.heightMm, params.depthMm].some(
      (n) => !Number.isFinite(n) || n <= 0 || n > 20000,
    ) ||
    [params.u, params.v].some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    !['floor', 'left', 'back', 'right'].includes(params.face)
  )
    throw new Error('모형 규격은 1–20,000mm, 면 위치는 0–100% 범위로 입력해 주세요.');
  if (!isPlanarReconstruction(params.kind) && params.face === 'floor') {
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
    ({ version }) => version.reconstruction?.version === 1 && version.code === code,
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
    version = await repos.materials.create({
      ...baseMaterial(),
      name: `${reconstructionLabels[params.kind]} · 재구성 모형`,
      code,
      category: params.kind,
      color: params.color,
      widthMm: params.widthMm,
      heightMm: params.heightMm,
      depthMm: params.depthMm,
      installation: params.face === 'floor' ? 'floor' : 'wall',

      views: [
        { assetId: asset.id, direction: '공간 공통 카메라', anchor: rendered?.anchor ?? { x: 0.5, y: 0.5 } },
      ],
      reconstruction: { version: 1, kind: params.kind },
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
    shadow: { x: 0, y: 0, opacity: params.face === 'floor' ? 0.16 : 0.025, blur: 0.008, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      kind: params.kind,
      orientation: params.orientation,
      appearanceAssetId: params.appearanceAssetId,
      color: params.color,
      widthMm: params.widthMm,
      heightMm: params.heightMm,
      depthMm: params.depthMm,
      version: 1,
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
      'kind' | 'color' | 'widthMm' | 'heightMm' | 'depthMm' | 'face' | 'u' | 'v' | 'orientation'
    >
  >,
  options: Pick<ReconstructionFixtureOptions, 'aspect' | 'repositories' | 'signal'> = {},
): Promise<FixtureInstance> {
  const meta = fixture.reconstruction,
    placement = fixture.roomPlacement;
  if (!meta || !placement) throw new Error('재구성 기본 모형을 선택해 주세요.');
  const next = await createReconstructionFixture({
    ...meta,
    kind: meta.kind as ReconstructionKind,
    room,
    face: placement.face,
    u: placement.u,
    v: placement.v,
    ...patch,
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
  next.roomPlacement!.scale = placement.scale;
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
  repositories?: Repositories;
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
  return repos.materials.create({
    ...baseMaterial(),
    name: `기존 ${options.kind === 'floor' ? '바닥' : '벽'} 타일 · 추정`,
    category: 'tile',
    code,
    color,
    widthMm,
    heightMm,
    depthMm: 10,

    textureAssetIds: [asset.id],
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
};
function candidatePlane(candidate: ReconstructionCandidate, review: ReconstructionReview) {
  const point = {
    x: (candidate.bounds.left + candidate.bounds.right) / 2,
    y: (candidate.bounds.top + candidate.bounds.bottom) / 2,
  };
  let best: { plane: ReconstructionPlane; score: number } | undefined;
  for (const plane of review.planes) {
    if (plane.face === 'floor') continue;
    try {
      const uv = transformPoint(homography(plane.quad), point);
      const outside = Math.max(0, -uv.x, uv.x - 1) + Math.max(0, -uv.y, uv.y - 1);
      if (outside > 0.35) continue;
      const score = outside * 10 + Math.abs(uv.x - 0.5) * 0.03;
      if (!best || score < best.score) best = { plane, score };
    } catch {
      /* Only evidence-supported source rectangles contribute a size. */
    }
  }
  return best?.plane;
}
export function estimateCandidateFixture(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
  room: RoomDefinition,
  placement: { face: RoomFace; u: number; v: number },
): Pick<ReconstructionFixtureOptions, 'widthMm' | 'heightMm' | 'depthMm' | 'orientation' | 'u' | 'v'> {
  const defaults = RECONSTRUCTION_DEFAULTS[candidate.kind],
    range = physicalRanges[candidate.kind];
  const plane =
    placement.face === 'floor'
      ? candidatePlane(candidate, review)
      : review.planes.find((p) => p.face === placement.face);
  const orientation: FixtureOrientation = plane?.face && plane.face !== 'floor' ? plane.face : 'back';
  let width = defaults.widthMm,
    height = defaults.heightMm;
  if (plane)
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
        dx * (plane.face === 'back' ? room.widthMm : room.depthMm * (plane.depthEnd - plane.depthStart));
      height = dy * room.heightMm * ((plane.verticalEnd ?? 1) - (plane.verticalStart ?? 0));
    } catch {
      /* Keep honest category estimates when the source perspective is unusable. */
    }
  const bounded = (n: number, limits: [number, number]) =>
    Math.round(Math.max(limits[0], Math.min(limits[1], n)) / 10) * 10;
  width = bounded(width, range.width);
  height = bounded(height, range.height);
  const depth = bounded(
    defaults.depthMm * Math.min(1.3, Math.max(0.75, width / defaults.widthMm)),
    range.depth,
  );
  // The observed bottom contour is the visible front contact, while rendering uses footprint centre.
  let { u, v } = frontContactToCentre(room, placement, depth, orientation);
  if (placement.face === 'floor') {
    const fitted = fitReconstructionFootprint(room, {
      ...placement,
      u,
      v,
      widthMm: width,
      heightMm: height,
      depthMm: depth,
      orientation,
    });
    u = fitted.u;
    v = fitted.v;
  }
  return { widthMm: width, heightMm: height, depthMm: depth, orientation, u, v };
}
export async function createReconstructionProject(
  file: File,
  room: RoomDefinition,
  options: {
    repositories?: Repositories;
    onStage?: (message: string) => void;
    signal?: AbortSignal;
    manual?: boolean;
  } = {},
): Promise<ProjectDocument> {
  if (!validateRoomDimensions(room)) throw new Error('공간 크기를 확인해 주세요.');
  const repos = options.repositories ?? getRepositories();
  checkAbort(options.signal);
  options.onStage?.('참고 사진의 형식과 크기 확인 중');
  const reference = await importImage(file, 'original', repos.assets);
  checkAbort(options.signal);
  let review: ReconstructionReview = {
    version: 1,
    analysis: 'manual',
    planes: [],
    candidates: [],
    warnings: ['직접 구성 모드예요. 원본 사진을 보면서 기존 타일과 기구를 추가해 주세요.'],
  };
  if (!options.manual) {
    const segmentation = await segmentRoom(
      reference.preview.blob,
      (message) => {
        if (!options.signal?.aborted) options.onStage?.(message);
      },
      { quality: 'reconstruction' },
    );
    checkAbort(options.signal);
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
  checkAbort(options.signal);
  options.onStage?.('같은 구도의 비교 공간 생성 중');
  const background = await renderRoomBackground(room);
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
  for (const candidate of review.candidates) {
    checkAbort(options.signal);
    const placement = candidate.requiresReview ? undefined : mapReconstructionCandidate(candidate, review);
    if (!placement) {
      if (!candidate.requiresReview)
        candidate.warning = '설치 면이나 접지점을 확정하지 못했어요. 위치 확인 후 직접 배치해 주세요.';
      continue;
    }
    options.onStage?.(`${reconstructionLabels[candidate.kind]} 기본 모형 준비 중`);
    const appearancePlane = review.planes.find((plane) => plane.face === placement.face);
    const appearanceAssetId =
      appearancePlane && (candidate.kind === 'mirror' || candidate.kind === 'window')
        ? await createReconstructionAppearance({
            reference: reference.preview,
            candidate,
            plane: appearancePlane,
            assets: repos.assets,
            signal: options.signal,
          })
        : undefined;
    const fixture = await createReconstructionFixture({
      kind: candidate.kind,
      appearanceAssetId,
      room,
      color: candidate.color,
      ...placement,
      ...estimateCandidateFixture(candidate, review, room, placement),
      aspect,
      repositories: repos,
      signal: options.signal,
    });
    before.fixtures.push(fixture);
    candidate.fixtureId = fixture.id;
    candidate.status = 'placed';
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
