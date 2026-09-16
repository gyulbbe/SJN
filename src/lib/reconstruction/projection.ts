import { reconstructionLocalBoxes } from './raised-glass-support';
import { Vector3 } from 'three';
import type { FixtureInstance, Quad } from '../types';
import type { RoomDefinition, RoomFace } from '../room-types';
import { createRoomCamera, roomFacePoint } from '../room-geometry';
import type { ReconstructionStandardOptions } from './types';

export const isPlanarReconstruction = (kind?: string) =>
  kind === 'mirror' || kind === 'door' || kind === 'window';
export type FixtureOrientation = 'back' | 'left' | 'right';
export const orientationAngle = (orientation: FixtureOrientation = 'back') =>
  orientation === 'left' ? Math.PI / 2 : orientation === 'right' ? -Math.PI / 2 : 0;
export type VolumePlacement = ReconstructionStandardOptions & {
  kind?: string;
  version?: 1 | 2;
  face: RoomFace;
  u: number;
  v: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  scale?: number;
  orientation?: FixtureOrientation;
};
/** V2 anchors the rear/bottom of wall fixtures; legacy sprites retain their original origin. */
export function reconstructionModelTransform(room: RoomDefinition, placement: VolumePlacement) {
  const origin = roomFacePoint(room, placement.face, placement.u, placement.v);
  const scale = placement.scale ?? 1;
  let angle = orientationAngle(placement.orientation);
  if (placement.version === 2) {
    if (placement.baseHeightMm !== undefined) origin.y = placement.baseHeightMm;
    if (placement.face !== 'floor') {
      angle = orientationAngle(placement.face);
      origin.add(
        new Vector3(0, 0, (placement.depthMm * scale) / 2).applyAxisAngle(new Vector3(0, 1, 0), angle),
      );
    } else if (placement.yawDegrees !== undefined) angle = (placement.yawDegrees * Math.PI) / 180;
  }
  return { origin, angle, scale };
}
export function frontContactToCentre(
  room: RoomDefinition,
  placement: { face: RoomFace; u: number; v: number },
  depthMm: number,
  orientation: FixtureOrientation = 'back',
) {
  let { u, v } = placement;
  if (placement.face === 'floor') {
    if (orientation === 'left') u -= depthMm / (2 * room.widthMm);
    else if (orientation === 'right') u += depthMm / (2 * room.widthMm);
    else v -= depthMm / (2 * room.depthMm);
  }
  return { ...placement, u, v };
}
/** Floor u/v denotes the centre of the physical footprint, not the detected front edge. */
export function fitReconstructionFootprint(room: RoomDefinition, placement: VolumePlacement) {
  const angle =
    placement.version === 2 && placement.yawDegrees !== undefined
      ? (placement.yawDegrees * Math.PI) / 180
      : orientationAngle(placement.orientation);
  const width = Math.abs(Math.cos(angle)) * placement.widthMm + Math.abs(Math.sin(angle)) * placement.depthMm;
  const depth = Math.abs(Math.sin(angle)) * placement.widthMm + Math.abs(Math.cos(angle)) * placement.depthMm;
  const requested = placement.scale ?? 1;
  const scale = Math.min(
    requested,
    room.widthMm / width,
    room.depthMm / depth,
    Math.max(1, room.heightMm - (placement.version === 2 ? (placement.baseHeightMm ?? 0) : 0)) /
      placement.heightMm,
  );
  const halfU = (width * scale) / (2 * room.widthMm),
    halfV = (depth * scale) / (2 * room.depthMm);
  return {
    u: Math.max(halfU, Math.min(1 - halfU, placement.u)),
    v: Math.max(halfV, Math.min(1 - halfV, placement.v)),
    scale,
  };
}
/** The same nominal, normalized model box is used by template capture and sprite placement. */
export function reconstructionVolumeProjection(
  room: RoomDefinition,
  placement: VolumePlacement,
  aspect: number,
) {
  const camera = createRoomCamera(room, aspect);
  const { origin, angle, scale } = reconstructionModelTransform(room, placement);
  const points = [];
  for (const box of reconstructionLocalBoxes(placement))
    for (const x of [box.min[0], box.max[0]])
      for (const y of [box.min[1], box.max[1]])
        for (const z of [box.min[2], box.max[2]]) {
          const world = new Vector3(x * scale, y * scale, z * scale);
          world
            .applyAxisAngle(new Vector3(0, 1, 0), angle)
            .add(origin)
            .project(camera);
          points.push({ x: (world.x + 1) / 2, y: (1 - world.y) / 2 });
        }
  const base = origin.clone().project(camera);
  const left = Math.min(...points.map((p) => p.x)),
    right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y)),
    bottom = Math.max(...points.map((p) => p.y));
  return { left, right, top, bottom, position: { x: (base.x + 1) / 2, y: (1 - base.y) / 2 } };
}
/** A rectangular wall object shares the exact wall perspective, including its centre anchor. */
export function projectReconstructionFixture(
  room: RoomDefinition,
  fixture: FixtureInstance,
  aspect: number,
): void {
  const placement = fixture.roomPlacement;
  const reconstruction = fixture.reconstruction;
  if (!placement || !reconstruction) {
    delete fixture.projectedQuad;
    return;
  }
  if (reconstruction.version === 2 || !isPlanarReconstruction(reconstruction.kind)) {
    delete fixture.projectedQuad;
    const volume = { ...reconstruction, ...placement, depthMm: reconstruction.depthMm };
    if (
      placement.face === 'floor' &&
      !reconstruction.support &&
      reconstruction.placementPolicy !== 'preserve'
    )
      Object.assign(placement, fitReconstructionFootprint(room, volume));
    const projected = reconstructionVolumeProjection(room, { ...volume, ...placement }, aspect);
    fixture.position = projected.position;
    fixture.width = projected.right - projected.left;
    fixture.height = projected.bottom - projected.top;
    if (reconstruction.version === 2) {
      fixture.anchor = {
        x: (projected.position.x - projected.left) / Math.max(1e-9, fixture.width),
        y: (projected.position.y - projected.top) / Math.max(1e-9, fixture.height),
      };
    }
    return;
  }
  if (placement.face === 'floor') {
    delete fixture.projectedQuad;
    return;
  }
  const camera = createRoomCamera(room, aspect);
  const origin = roomFacePoint(room, placement.face, placement.u, placement.v);
  const horizontal =
    placement.face === 'left'
      ? new Vector3(0, 0, -1)
      : placement.face === 'right'
        ? new Vector3(0, 0, 1)
        : new Vector3(1, 0, 0);
  const up = new Vector3(0, 1, 0);
  const angle = (fixture.rotation * Math.PI) / 180;
  const axisX = horizontal.clone().multiplyScalar(Math.cos(angle)).addScaledVector(up, -Math.sin(angle));
  const axisY = horizontal.clone().multiplyScalar(Math.sin(angle)).addScaledVector(up, Math.cos(angle));
  const width = placement.widthMm * placement.scale,
    height = placement.heightMm * placement.scale;
  const point = (x: number, y: number) => {
    const p = origin
      .clone()
      .addScaledVector(axisX, x * width)
      .addScaledVector(axisY, y * height)
      .project(camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  };
  fixture.projectedQuad = [
    point(-fixture.anchor.x, fixture.anchor.y),
    point(1 - fixture.anchor.x, fixture.anchor.y),
    point(1 - fixture.anchor.x, fixture.anchor.y - 1),
    point(-fixture.anchor.x, fixture.anchor.y - 1),
  ] as Quad;
  const p = origin.project(camera);
  fixture.position = { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  const xs = fixture.projectedQuad.map((corner) => corner.x),
    ys = fixture.projectedQuad.map((corner) => corner.y);
  fixture.width = Math.max(...xs) - Math.min(...xs);
  fixture.height = Math.max(...ys) - Math.min(...ys);
}
