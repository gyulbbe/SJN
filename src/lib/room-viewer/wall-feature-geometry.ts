import { Box3, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { roomFacePoint } from '../room-geometry';
import type { RoomDefinition, RoomFace } from '../room-types';
import {
  resolveWallFeature,
  validateWallFeatures,
  WallFeatureValidationError,
  type ResolvedWallFeature,
  type WallFeatureV1,
} from '../wall-features';
import type { ViewerSurfacePatch } from './surfaces';

type WallFace = WallFeatureV1['face'];
type Triple = [number, number, number];
type Uv = [number, number];
export type WallFeaturePieceRole =
  'base-wall' | 'rear' | 'reveal-left' | 'reveal-right' | 'reveal-top' | 'reveal-bottom' | 'floor-extension';
export type WallFeaturePiece = {
  geometry: BufferGeometry;
  /** The wall containing the opening, including for an alcove floor extension. */
  ownerFace: WallFace;
  role: WallFeaturePieceRole;
  featureId?: string;
  parentPatch: ViewerSurfacePatch;
  sourceSurfaceId?: string;
  tileFace: RoomFace;
  uvChart: 'wall-global' | 'wall-unfolded' | 'floor-global';
  expectedNormal: Triple;
  worldBounds: Box3;
};
export type WallFeaturePieces = {
  pieces: WallFeaturePiece[];
  affectedFaces: ReadonlySet<RoomFace>;
  /** Only feature interiors/extensions, not the remaining main wall. */
  structureBounds: Box3;
  /** Owns all returned geometries, no materials/textures. Safe to call repeatedly. */
  dispose(): void;
};

const WALLS: WallFace[] = ['left', 'back', 'right'];
const normalFor = (face: WallFace): Triple =>
  face === 'back' ? [0, 0, 1] : face === 'left' ? [1, 0, 0] : [-1, 0, 0];
const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/** Patches must be the non-overlapping full partition returned by viewerSurfacePatches. */
function wallPatches(patches: readonly ViewerSurfacePatch[], face: RoomFace) {
  const result = patches.filter((p) => p.face === face).sort((a, b) => a.from - b.from);
  let end = 0;
  for (const patch of result) {
    if (
      !Number.isFinite(patch.from) ||
      !Number.isFinite(patch.to) ||
      patch.from !== end ||
      patch.to <= patch.from ||
      patch.to > 1
    )
      throw new Error('벽 구조의 부모 자재 구간이 전체 면을 겹침 없이 나누어야 해요.');
    end = patch.to;
  }
  if (end !== 1 || (face === 'floor' && result.length !== 1))
    throw new Error('벽 구조의 부모 벽·바닥 자재 구간이 없거나 올바르지 않아요.');
  return result;
}

/**
 * Splits only affected walls; callers retain the original geometry path for every other patch.
 * No photo coordinates, materials, textures, renderer or browser APIs are consumed here.
 */
export function buildWallFeaturePieces(
  room: RoomDefinition,
  patches: readonly ViewerSurfacePatch[],
  features: readonly WallFeatureV1[],
): WallFeaturePieces {
  const issues = validateWallFeatures(room, features);
  if (issues.length) throw new WallFeatureValidationError(issues);
  const resolved = features.map((feature) => resolveWallFeature(room, feature));
  const affectedFaces = WALLS.filter((face) => resolved.some((feature) => feature.face === face));
  // Validate all parents before allocating geometry, retaining neutral/ambiguous surface entries.
  const parents = new Map(affectedFaces.map((face) => [face, wallPatches(patches, face)]));
  const floor = resolved.some((f) => f.kind === 'floor-alcove')
    ? wallPatches(patches, 'floor')[0]
    : undefined;
  const pieces: WallFeaturePiece[] = [];
  const structureBounds = new Box3();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const piece of pieces) piece.geometry.dispose();
  };
  const add = (
    ownerFace: WallFace,
    role: WallFeaturePieceRole,
    parentPatch: ViewerSurfacePatch,
    points: Vector3[],
    uv: Uv[],
    expectedNormal: Triple,
    featureId?: string,
  ) => {
    const geometry = new BufferGeometry();
    try {
      const cross = points[2].clone().sub(points[0]).cross(points[1].clone().sub(points[0]));
      const inward = cross.dot(new Vector3(...expectedNormal)) > 0;
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(
          points.flatMap((p) => p.toArray()),
          3,
        ),
      );
      geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
      // Reject dimensions lost during GPU-buffer conversion rather than silently closing a hole.
      const positions = geometry.getAttribute('position');
      const a = new Vector3().fromBufferAttribute(positions, 0);
      const b = new Vector3().fromBufferAttribute(positions, 1);
      const c = new Vector3().fromBufferAttribute(positions, 2);
      const d = new Vector3().fromBufferAttribute(positions, 3);
      if (
        b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() === 0 ||
        c.clone().sub(a).cross(d.clone().sub(a)).lengthSq() === 0
      )
        throw new Error('벽 구조의 면이 그래픽 좌표 정밀도보다 작아요. 치수를 확인해 주세요.');
      geometry.setIndex(inward ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const piece: WallFeaturePiece = {
        geometry,
        ownerFace,
        role,
        featureId,
        parentPatch,
        sourceSurfaceId: parentPatch.surface?.id,
        tileFace: parentPatch.face,
        uvChart:
          role === 'floor-extension'
            ? 'floor-global'
            : role.startsWith('reveal-')
              ? 'wall-unfolded'
              : 'wall-global',
        expectedNormal,
        worldBounds: geometry.boundingBox!.clone(),
      };
      geometry.userData.wallFeature = {
        ownerFace,
        role,
        featureId,
        sourceSurfaceId: piece.sourceSurfaceId,
        parentPatch: { face: parentPatch.face, from: parentPatch.from, to: parentPatch.to },
        tileFace: piece.tileFace,
        uvChart: piece.uvChart,
        expectedNormal: [...expectedNormal],
        worldBounds: { min: piece.worldBounds.min.toArray(), max: piece.worldBounds.max.toArray() },
      };
      pieces.push(piece);
      if (featureId) structureBounds.union(piece.worldBounds);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
  };
  const point = (face: WallFace, u: number, v: number, depth = 0) =>
    roomFacePoint(room, face, u, v).addScaledVector(new Vector3(...normalFor(face)), -depth);
  const rect = (face: WallFace, u0: number, v0: number, u1: number, v1: number, depth = 0) => [
    point(face, u0, v0, depth),
    point(face, u1, v0, depth),
    point(face, u1, v1, depth),
    point(face, u0, v1, depth),
  ];
  const rectUv = (u0: number, v0: number, u1: number, v1: number): Uv[] => [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  const interiorPatch = (bands: ViewerSurfacePatch[], v: number, edge: 'top' | 'bottom') => {
    // Top belongs to the interval below it; bottom to the one above it. No fuzzy band selection.
    const result = bands.find((p) => (edge === 'top' ? p.from <= v && v < p.to : p.from < v && v <= p.to));
    if (!result) throw new Error('홈 내부의 부모 자재 구간을 찾을 수 없어요.');
    return result;
  };
  const addInterior = (feature: ResolvedWallFeature, bands: ViewerSurfacePatch[]) => {
    const { face, id, opening: o, depthMm: d, wallSpanMm: length } = feature;
    const uAxis = roomFacePoint(room, face, 1, 0)
      .sub(roomFacePoint(room, face, 0, 0))
      .normalize();
    for (const patch of bands) {
      const top = Math.max(o.top, patch.from),
        bottom = Math.min(o.bottom, patch.to);
      if (top >= bottom) continue;
      add(
        face,
        'rear',
        patch,
        rect(face, o.left, top, o.right, bottom, d),
        rectUv(o.left, top, o.right, bottom),
        normalFor(face),
        id,
      );
      add(
        face,
        'reveal-left',
        patch,
        [
          point(face, o.left, top),
          point(face, o.left, top, d),
          point(face, o.left, bottom, d),
          point(face, o.left, bottom),
        ],
        [
          [o.left, top],
          [o.left + d / length, top],
          [o.left + d / length, bottom],
          [o.left, bottom],
        ],
        uAxis.toArray(),
        id,
      );
      add(
        face,
        'reveal-right',
        patch,
        [
          point(face, o.right, top),
          point(face, o.right, top, d),
          point(face, o.right, bottom, d),
          point(face, o.right, bottom),
        ],
        [
          [o.right, top],
          [o.right - d / length, top],
          [o.right - d / length, bottom],
          [o.right, bottom],
        ],
        uAxis.clone().negate().toArray(),
        id,
      );
    }
    add(
      face,
      'reveal-top',
      interiorPatch(bands, o.top, 'top'),
      [
        point(face, o.left, o.top),
        point(face, o.right, o.top),
        point(face, o.right, o.top, d),
        point(face, o.left, o.top, d),
      ],
      [
        [o.left, o.top],
        [o.right, o.top],
        [o.right, o.top + d / room.heightMm],
        [o.left, o.top + d / room.heightMm],
      ],
      [0, -1, 0],
      id,
    );
    const bottomPoints = [
      point(face, o.left, o.bottom),
      point(face, o.right, o.bottom),
      point(face, o.right, o.bottom, d),
      point(face, o.left, o.bottom, d),
    ];
    if (feature.kind === 'floor-alcove')
      add(
        face,
        'floor-extension',
        floor!,
        bottomPoints,
        bottomPoints.map((p) => [(p.x + room.widthMm / 2) / room.widthMm, p.z / room.depthMm]),
        [0, 1, 0],
        id,
      );
    else
      add(
        face,
        'reveal-bottom',
        interiorPatch(bands, o.bottom, 'bottom'),
        bottomPoints,
        [
          [o.left, o.bottom],
          [o.right, o.bottom],
          [o.right, o.bottom - d / room.heightMm],
          [o.left, o.bottom - d / room.heightMm],
        ],
        [0, 1, 0],
        id,
      );
  };
  try {
    for (const face of affectedFaces) {
      const openings = resolved.filter((f) => f.face === face);
      const bands = parents.get(face)!;
      const us = uniqueSorted([0, 1, ...openings.flatMap((f) => [f.opening.left, f.opening.right])]);
      for (const patch of bands) {
        const vs = uniqueSorted([
          patch.from,
          patch.to,
          ...openings
            .flatMap((f) => [f.opening.top, f.opening.bottom])
            .filter((v) => v > patch.from && v < patch.to),
        ]);
        for (let x = 0; x < us.length - 1; x++)
          for (let y = 0; y < vs.length - 1; y++) {
            const u0 = us[x],
              u1 = us[x + 1],
              v0 = vs[y],
              v1 = vs[y + 1];
            const u = (u0 + u1) / 2,
              v = (v0 + v1) / 2;
            if (openings.some(({ opening: o }) => o.left < u && u < o.right && o.top < v && v < o.bottom))
              continue;
            add(
              face,
              'base-wall',
              patch,
              rect(face, u0, v0, u1, v1),
              rectUv(u0, v0, u1, v1),
              normalFor(face),
            );
          }
      }
      for (const opening of openings) addInterior(opening, bands);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { pieces, affectedFaces: new Set(affectedFaces), structureBounds, dispose };
}
