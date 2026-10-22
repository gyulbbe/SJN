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
import { cellLeft, cellRight, cellsAlong } from '../room-face-partition';
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

/**
 * Patches must be the non-overlapping full partition returned by viewerSurfacePatches: rows of the
 * whole face, or a grid of cells where a region splits them. Row-major, top to bottom.
 */
function wallPatches(patches: readonly ViewerSurfacePatch[], face: RoomFace) {
  const result = patches
    .filter((p) => p.face === face)
    .sort((a, b) => a.from - b.from || cellLeft(a) - cellLeft(b));
  const us = uniqueSorted(result.flatMap((p) => [cellLeft(p), cellRight(p)]));
  const vs = uniqueSorted(result.flatMap((p) => [p.from, p.to]));
  if (
    result.some(
      (p) =>
        ![p.from, p.to, cellLeft(p), cellRight(p)].every(Number.isFinite) ||
        p.to <= p.from ||
        cellRight(p) <= cellLeft(p),
    )
  )
    throw new Error('벽 구조의 부모 자재 구간이 전체 면을 겹침 없이 나누어야 해요.');
  if (!result.length || us[0] !== 0 || us.at(-1) !== 1 || vs[0] !== 0 || vs.at(-1) !== 1)
    throw new Error('벽 구조의 부모 벽·바닥 자재 구간이 없거나 올바르지 않아요.');
  // Every grid cell is covered by exactly one patch, which spans whole grid cells only.
  let covered = 0;
  for (let y = 0; y < vs.length - 1; y++)
    for (let x = 0; x < us.length - 1; x++) {
      const u = (us[x] + us[x + 1]) / 2,
        v = (vs[y] + vs[y + 1]) / 2;
      const over = result.filter((p) => cellLeft(p) < u && u < cellRight(p) && p.from < v && v < p.to);
      if (over.length !== 1) throw new Error('벽 구조의 부모 자재 구간이 전체 면을 겹침 없이 나누어야 해요.');
      covered += (us[x + 1] - us[x]) * (vs[y + 1] - vs[y]);
    }
  const area = result.reduce((sum, p) => sum + (cellRight(p) - cellLeft(p)) * (p.to - p.from), 0);
  if (Math.abs(area - covered) > 1e-9)
    throw new Error('벽 구조의 부모 자재 구간이 전체 면을 겹침 없이 나누어야 해요.');
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
  const floor = resolved.some((f) => f.kind === 'floor-alcove') ? wallPatches(patches, 'floor') : undefined;
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
        parentPatch: {
          face: parentPatch.face,
          from: parentPatch.from,
          to: parentPatch.to,
          ...(parentPatch.left !== undefined ? { left: parentPatch.left, right: parentPatch.right } : {}),
        },
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
  /**
   * The cells along one opening edge, each with the part of [from, to] it holds. A point on a cell
   * edge goes to the cell inside the opening: the top to the cell below it, the bottom to the cell
   * above it, as the bands did. No fuzzy choice.
   */
  const along = (
    cells: readonly ViewerSurfacePatch[],
    axis: 'u' | 'v',
    at: number,
    side: 'after' | 'before',
    from: number,
    to: number,
  ) => {
    const result = cellsAlong(cells, axis, at, side)
      .map((cell) => {
        const start = axis === 'v' ? cellLeft(cell) : cell.from,
          end = axis === 'v' ? cellRight(cell) : cell.to;
        return { cell, from: Math.max(from, start), to: Math.min(to, end) };
      })
      .filter((part) => part.from < part.to)
      .sort((a, b) => a.from - b.from);
    if (!result.length) throw new Error('홈 내부의 부모 자재 구간을 찾을 수 없어요.');
    return result;
  };
  const addInterior = (feature: ResolvedWallFeature, cells: ViewerSurfacePatch[]) => {
    const { face, id, opening: o, depthMm: d, wallSpanMm: length } = feature;
    const uAxis = roomFacePoint(room, face, 1, 0)
      .sub(roomFacePoint(room, face, 0, 0))
      .normalize();
    for (const patch of cells) {
      const top = Math.max(o.top, patch.from),
        bottom = Math.min(o.bottom, patch.to);
      if (top >= bottom) continue;
      const left = Math.max(o.left, cellLeft(patch)),
        right = Math.min(o.right, cellRight(patch));
      if (left < right)
        add(
          face,
          'rear',
          patch,
          rect(face, left, top, right, bottom, d),
          rectUv(left, top, right, bottom),
          normalFor(face),
          id,
        );
      if (cellLeft(patch) <= o.left && o.left < cellRight(patch))
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
      if (cellLeft(patch) < o.right && o.right <= cellRight(patch))
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
    for (const part of along(cells, 'v', o.top, 'after', o.left, o.right))
      add(
        face,
        'reveal-top',
        part.cell,
        [
          point(face, part.from, o.top),
          point(face, part.to, o.top),
          point(face, part.to, o.top, d),
          point(face, part.from, o.top, d),
        ],
        [
          [part.from, o.top],
          [part.to, o.top],
          [part.to, o.top + d / room.heightMm],
          [part.from, o.top + d / room.heightMm],
        ],
        [0, -1, 0],
        id,
      );
    const bottomPoints = (from: number, to: number) => [
      point(face, from, o.bottom),
      point(face, to, o.bottom),
      point(face, to, o.bottom, d),
      point(face, from, o.bottom, d),
    ];
    if (feature.kind === 'floor-alcove')
      // The alcove's floor continues the floor cells it meets, split where they are (wall u).
      for (const part of floorEdge(face, o.left, o.right)) {
        const points = bottomPoints(part.from, part.to);
        add(
          face,
          'floor-extension',
          part.cell,
          points,
          points.map((p) => [(p.x + room.widthMm / 2) / room.widthMm, p.z / room.depthMm]),
          [0, 1, 0],
          id,
        );
      }
    else
      for (const part of along(cells, 'v', o.bottom, 'before', o.left, o.right))
        add(
          face,
          'reveal-bottom',
          part.cell,
          bottomPoints(part.from, part.to),
          [
            [part.from, o.bottom],
            [part.to, o.bottom],
            [part.to, o.bottom - d / room.heightMm],
            [part.from, o.bottom - d / room.heightMm],
          ],
          [0, 1, 0],
          id,
        );
  };
  /** The floor cells along a wall's foot, as wall u from `from` to `to` (left wall u = 1 − floor v). */
  const floorEdge = (face: WallFace, from: number, to: number) => {
    const cells = floor!;
    const parts =
      face === 'back'
        ? along(cells, 'v', 0, 'after', from, to)
        : cellsAlong(cells, 'u', face === 'left' ? 0 : 1, face === 'left' ? 'after' : 'before')
            .map((cell) =>
              face === 'left'
                ? { cell, from: Math.max(from, 1 - cell.to), to: Math.min(to, 1 - cell.from) }
                : { cell, from: Math.max(from, cell.from), to: Math.min(to, cell.to) },
            )
            .filter((part) => part.from < part.to)
            .sort((a, b) => a.from - b.from);
    if (!parts.length) throw new Error('홈 내부의 부모 자재 구간을 찾을 수 없어요.');
    return parts;
  };
  try {
    for (const face of affectedFaces) {
      const openings = resolved.filter((f) => f.face === face);
      const cells = parents.get(face)!;
      for (const patch of cells) {
        const us = uniqueSorted([
          cellLeft(patch),
          cellRight(patch),
          ...openings
            .flatMap((f) => [f.opening.left, f.opening.right])
            .filter((u) => u > cellLeft(patch) && u < cellRight(patch)),
        ]);
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
      for (const opening of openings) addInterior(opening, cells);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { pieces, affectedFaces: new Set(affectedFaces), structureBounds, dispose };
}
