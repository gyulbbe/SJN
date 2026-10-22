import { roomFaceSizeMm } from './room-geometry';
import { regionShapeIssue, regionsOverlap, regionUv } from './room-surface-regions';
import type { RoomFace } from './room-types';
import type { Scene, Surface } from './types';

/**
 * One rectangle of a room face in face UV (u left to right, v top to bottom as roomFacePoint) and
 * the surface drawn there; none where nothing or an ambiguous choice would be drawn. `left`/`right`
 * are absent for a whole-width cell, so a scene without regions gives the old height intervals.
 */
export type FaceCell = {
  face: RoomFace;
  from: number;
  to: number;
  left?: number;
  right?: number;
  surface?: Surface;
  /** The base layer's height interval (the whole face or a band) this cell was cut from. */
  row?: { from: number; to: number };
};
export type FacePartition = {
  face: RoomFace;
  /** Row by row from the top, each row left to right; every cell edge is on the face's grid lines. */
  cells: FaceCell[];
  /** The area rules cannot give this face a physical area (unknown, invalid or ambiguous parts). */
  unclear: boolean;
  /** The surfaces of this face that were considered. */
  surfaces: Surface[];
};
export type PartitionNotice = { id: string; name: string; message: string };

export const ROOM_FACES: readonly RoomFace[] = ['floor', 'left', 'back', 'right'];
const hasAdditionalMask = (s: Surface) =>
  !!(s.mask.strokes.length || s.mask.holes?.length || s.mask.polygons?.length);
const validBand = (face: RoomFace, b: NonNullable<Surface['reconstructionBand']>) =>
  face !== 'floor' &&
  Number.isFinite(b.from) &&
  Number.isFinite(b.to) &&
  b.from >= 0 &&
  b.to <= 1 &&
  b.from < b.to;
const isFull = (s: Surface) =>
  !s.reconstructionBand || (s.reconstructionBand.from === 0 && s.reconstructionBand.to === 1);
const cellLeft = (cell: Pick<FaceCell, 'left'>) => cell.left ?? 0;
const cellRight = (cell: Pick<FaceCell, 'right'>) => cell.right ?? 1;
export { cellLeft, cellRight };

/**
 * The one place that decides which surface covers which part of each room face, for the 3D
 * renderer (and through it the editor stage, viewer, downloads and AI input), the physical areas,
 * the quotation and the material usage. Height bands split a face into rows; a region with a tile
 * covers its rectangle on top of them (a region without a tile covers nothing). Overlaps are never
 * resolved by order: the overlapped part has no surface and is reported.
 * `include` picks the surfaces taken into account (the usage counts assigned ones only).
 */
export function partitionRoomFaces(
  scene: Pick<Scene, 'room' | 'surfaces'>,
  include: (surface: Surface) => boolean = () => true,
): { faces: FacePartition[]; notices: PartitionNotice[] } {
  const notices: PartitionNotice[] = [];
  const warn = (s: Surface, message: string) => notices.push({ id: s.id, name: s.name, message });
  for (const s of scene.surfaces) {
    if (!s.roomFace || s.geometryMode !== 'room')
      warn(s, '사진 좌표로 편집한 면은 입체 위치를 확정할 수 없어 이 보기에서 자재를 표시하지 않아요.');
    else if (hasAdditionalMask(s))
      warn(s, '사진 좌표의 브러시·보호 구멍은 이 보기에서 재현하지 않으며, 알려진 공간 면 범위를 사용해요.');
  }
  const faces: FacePartition[] = [];
  for (const face of ROOM_FACES) {
    const surfaces = scene.surfaces.filter((s) => s.roomFace === face && include(s));
    let unclear = surfaces.some((s) => s.geometryMode !== 'room');
    const candidates = surfaces.filter((s) => s.geometryMode === 'room');
    // Base layer: the whole face and its height bands, exactly as before regions existed.
    const valid = candidates.filter((s) => {
      if (s.region) return false;
      if (s.reconstructionBand && !validBand(face, s.reconstructionBand)) {
        warn(s, '벽 높이 구간이 잘못되어 자재를 표시하지 않아요.');
        unclear = true;
        return false;
      }
      return true;
    });
    const full = valid.filter(isFull);
    const bands = valid.filter((s) => !full.includes(s));
    const conflicting = new Set<Surface>();
    for (const a of bands)
      for (const b of bands)
        if (
          a !== b &&
          Math.min(a.reconstructionBand!.to, b.reconstructionBand!.to) -
            Math.max(a.reconstructionBand!.from, b.reconstructionBand!.from) >
            1e-9
        ) {
          conflicting.add(a);
          conflicting.add(b);
        }
    for (const s of conflicting)
      warn(s, '겹치는 벽 구간의 앞뒤를 임의로 정하지 않아요. 해당 자재 구간을 확인해 주세요.');
    if (full.length > 1)
      full.forEach((s) => warn(s, '같은 공간 면에 전체 자재가 여러 개여서 자동 선택하지 않아요.'));
    if (conflicting.size || full.length > 1) unclear = true;
    // Region layer: only regions with a tile cover anything.
    const size = scene.room ? roomFaceSizeMm(scene.room, face) : undefined;
    const regions = candidates.filter((s) => {
      if (!s.region) return false;
      if (!size || s.reconstructionBand || regionShapeIssue(s.region, size)) {
        warn(s, '부분 타일의 범위가 잘못되어 자재를 표시하지 않아요.');
        unclear = true;
        return false;
      }
      return !!s.materialVersionId;
    });
    const overlapping = new Set<Surface>();
    for (const a of regions)
      for (const b of regions)
        if (a !== b && regionsOverlap(a.region!, b.region!)) {
          overlapping.add(a);
          overlapping.add(b);
        }
    for (const s of overlapping)
      warn(s, '겹치는 부분 타일의 앞뒤를 임의로 정하지 않아요. 해당 부분 타일을 확인해 주세요.');
    if (overlapping.size) unclear = true;
    const boxes = new Map(regions.map((s) => [s, regionUv(s.region!, size!)]));
    const us = [...new Set([0, 1, ...[...boxes.values()].flatMap((b) => [b.left, b.right])])].sort(
      (a, b) => a - b,
    );
    const regionRows = [...boxes.values()].flatMap((b) => [b.top, b.bottom]);
    const boundaries = [
      ...new Set([0, 1, ...bands.flatMap((s) => [s.reconstructionBand!.from, s.reconstructionBand!.to])]),
    ].sort((a, b) => a - b);
    const cells: FaceCell[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i],
        to = boundaries[i + 1],
        mid = (from + to) / 2;
      const covering = bands.filter(
        (s) => s.reconstructionBand!.from <= mid && s.reconstructionBand!.to >= mid,
      );
      const base =
        covering.length === 1 && !conflicting.has(covering[0])
          ? covering[0]
          : covering.length
            ? undefined
            : full.length === 1
              ? full[0]
              : undefined;
      if (!boxes.size) {
        cells.push({ face, from, to, surface: base });
        continue;
      }
      const vs = [...new Set([from, to, ...regionRows.filter((v) => v > from && v < to)])].sort(
        (a, b) => a - b,
      );
      for (let y = 0; y < vs.length - 1; y++)
        for (let x = 0; x < us.length - 1; x++) {
          const u = (us[x] + us[x + 1]) / 2,
            v = (vs[y] + vs[y + 1]) / 2;
          const over = regions.filter((s) => {
            const b = boxes.get(s)!;
            return b.left <= u && u <= b.right && b.top <= v && v <= b.bottom;
          });
          const surface =
            over.length === 1 && !overlapping.has(over[0]) ? over[0] : over.length ? undefined : base;
          cells.push({
            face,
            from: vs[y],
            to: vs[y + 1],
            ...(us.length > 2 ? { left: us[x], right: us[x + 1] } : {}),
            surface,
            row: { from, to },
          });
        }
    }
    faces.push({ face, cells, unclear, surfaces });
  }
  return { faces, notices };
}

/**
 * The cell covering a face point. `inside` says from which side a point on a cell edge is taken:
 * a wall feature's interior belongs to the cell just inside its opening (see wall-feature-geometry).
 */
export function cellsAlong(
  cells: readonly FaceCell[],
  axis: 'u' | 'v',
  at: number,
  side: 'after' | 'before',
): FaceCell[] {
  return cells.filter((cell) => {
    const start = axis === 'u' ? cellLeft(cell) : cell.from,
      end = axis === 'u' ? cellRight(cell) : cell.to;
    return side === 'after' ? start <= at && at < end : start < at && at <= end;
  });
}
