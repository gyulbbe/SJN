import { Quaternion, Vector3 } from 'three';
import type { ProductMesh } from '../../src/lib/product3d/state-types';
import { gridBox, mergeMeshes } from './product3d-meshes';

export const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
export const radians = (degrees: number) => (degrees * Math.PI) / 180;
export const degrees = (value: number) => (value * 180) / Math.PI;
/** Angle between two directions of one line (a mirror plane's normal), 0–90°. */
export const lineGap = (a: number, b: number) => {
  const d = ((degrees(a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
};
export const around = (value: number, target: number) =>
  Math.abs(((((value - target + 540) % 360) + 360) % 360) - 180);

/** A toilet-like model in the standing frame: a low body and a tall tank at the back (+x), symmetric about y = 0. */
export function toilet(divisions = 18) {
  const body = gridBox([0, -0.18, 0], [0.7, 0.18, 0.4], divisions);
  const tank = gridBox([0.5, -0.17, 0.4], [0.7, 0.17, 0.85], divisions);
  return mergeMeshes(body, tank);
}
/** Points scattered over a cylinder standing on +z: round, so every vertical plane through its axis mirrors it alike. */
export function roundPoints(count = 6000) {
  let seed = 11;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const turn = random() * 2 * Math.PI;
    positions.set([0.3 * Math.cos(turn), 0.3 * Math.sin(turn), random() * 0.8], i * 3);
  }
  return { positions, indices: new Uint32Array(0) };
}
/** The mesh turned about +z by `yaw` degrees and moved, so its axes are not the standing frame's. */
export function placed(
  mesh: { positions: Float32Array; indices: Uint32Array },
  yaw: number,
  shift: [number, number, number],
) {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), radians(yaw));
  const positions = new Float32Array(mesh.positions.length);
  const v = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyQuaternion(q);
    positions.set([v.x + shift[0], v.y + shift[1], v.z + shift[2]], i);
  }
  return { positions, indices: mesh.indices };
}
export const withColours = (mesh: { positions: Float32Array; indices: Uint32Array }): ProductMesh => ({
  ...mesh,
  colors: new Float32Array(mesh.positions.length).fill(0.8),
});
