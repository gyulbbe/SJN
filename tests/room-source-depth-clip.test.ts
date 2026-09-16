import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import { fitSourceDepthClip, visibleMeshBounds } from '../src/lib/room-viewer/depth-clip';
import { createSourceCamera } from '../src/lib/reconstruction/source-camera';

function camera(position: [number, number, number] = [0, 1200, 3200], yaw = 0) {
  return createSourceCamera({
    version: 1,
    positionMm: position,
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).toArray() as [
      number,
      number,
      number,
      number,
    ],
    verticalFovDegrees: 64,
    image: { width: 960, height: 1280 },
  });
}
const box = (a: number[], b: number[]) => new Box3(new Vector3(...a), new Vector3(...b));
function walls(w = 2400, h = 2400, d = 2400) {
  return [
    box([-w / 2, 0, 0], [w / 2, 0, d]),
    box([-w / 2, h, 0], [w / 2, h, d]),
    box([-w / 2, 0, 0], [-w / 2, h, d]),
    box([w / 2, 0, 0], [w / 2, h, d]),
    box([-w / 2, 0, 0], [w / 2, h, 0]),
    box([-w / 2, 0, d], [w / 2, h, d]),
  ];
}
function proveSamplesRemain(c: PerspectiveCamera, bounds: Box3[]) {
  const initial = c.clone(),
    optics = {
      position: c.position.toArray(),
      quaternion: c.quaternion.toArray(),
      fov: c.fov,
      aspect: c.aspect,
      zoom: c.zoom,
      view: structuredClone(c.view),
    };
  const report = fitSourceDepthClip(c, bounds);
  expect(report).toBeDefined();
  expect(c.near).toBeGreaterThanOrEqual(0.1);
  expect(c.far).toBeGreaterThan(c.near);
  expect({
    position: c.position.toArray(),
    quaternion: c.quaternion.toArray(),
    fov: c.fov,
    aspect: c.aspect,
    zoom: c.zoom,
    view: c.view,
  }).toEqual(optics);
  let checked = 0;
  for (const b of bounds)
    for (let ix = 0; ix <= 6; ix++)
      for (let iy = 0; iy <= 6; iy++)
        for (let iz = 0; iz <= 6; iz++) {
          if (ix !== 0 && ix !== 6 && iy !== 0 && iy !== 6 && iz !== 0 && iz !== 6) continue;
          const p = new Vector3(
            b.min.x + ((b.max.x - b.min.x) * ix) / 6,
            b.min.y + ((b.max.y - b.min.y) * iy) / 6,
            b.min.z + ((b.max.z - b.min.z) * iz) / 6,
          );
          const depth = -p.clone().applyMatrix4(initial.matrixWorldInverse).z,
            old = p.clone().project(initial),
            now = p.clone().project(c);
          if (depth < 0.1 || ![old.x, old.y, now.x, now.y].every(Number.isFinite)) continue;
          expect(now.x).toBeCloseTo(old.x, 10);
          expect(now.y).toBeCloseTo(old.y, 10);
          if (depth >= 0.1 && Math.abs(old.x) <= 1 && Math.abs(old.y) <= 1) {
            expect(now.z).toBeGreaterThanOrEqual(-1 - 1e-8);
            expect(now.z).toBeLessThanOrEqual(1 + 1e-8);
            checked++;
          }
        }
  expect(checked).toBeGreaterThan(0);
  return report!;
}
describe('photo viewer depth precision from visible shared bounds', () => {
  it('resolves a sub-mm manufactured face gap without changing pixel optics', () => {
    const c = camera(),
      bounds = [box([-600, 600, 0], [600, 1800, 25]), box([-580, 620, 25.625], [580, 1780, 25.625])];
    const depthDelta = () =>
      Math.abs(new Vector3(0, 1200, 25).project(c).z - new Vector3(0, 1200, 25.625).project(c).z) *
      0.5 *
      (2 ** 24 - 1);
    expect(depthDelta()).toBeLessThan(1);
    proveSamplesRemain(c, bounds);
    expect(depthDelta()).toBeGreaterThan(100);
    expect(c.near).toBeGreaterThan(100);
    expect(c.far).toBeLessThan(4000);
  });
  it('handles an eye inside the room at every quarter turn without using room-box zero depth', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const c = camera([0, 1200, 1200], yaw);
      const result = proveSamplesRemain(c, walls());
      expect(result.nearMm).toBeGreaterThan(1);
    }
  });
  it('keeps 1mm-close surfaces visible and chooses conservative depth when inside a product bound', () => {
    const c = camera([0, 1200, 1]);
    const report = proveSamplesRemain(c, walls());
    expect(report.nearMm).toBeLessThan(1);
    const embedded = camera([0, 1200, 1200]);
    const r = fitSourceDepthClip(embedded, [...walls(), box([-100, 1100, 1100], [100, 1300, 1300])]);
    expect(r?.nearMm).toBe(0.1);
  });
  it('covers smallest and largest supported rooms, outside/inside eyes, pan, zoom and 90 degree pitch', () => {
    for (const [w, h, d] of [
      [500, 1000, 500],
      [20000, 6000, 20000],
    ]) {
      for (const position of [
        [0, h / 2, d * 1.5],
        [0, h / 2, d * 0.5],
      ] as [number, number, number][]) {
        for (const zoom of [0.25, 1, 8])
          for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
            const c = camera(position, yaw);
            c.zoom = zoom;
            // Centered views always see a room face; offscreen views are tested separately.
            c.updateProjectionMatrix();
            const report = fitSourceDepthClip(c, walls(w, h, d));
            if (report) proveSamplesRemain(c, walls(w, h, d));
            expect(c.near).toBeGreaterThanOrEqual(0.1);
          }
      }
      for (const pitch of [-Math.PI / 2, Math.PI / 2]) {
        const c = camera([0, h / 2, d * 0.5]);
        c.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), pitch);
        c.updateMatrixWorld(true);
        proveSamplesRemain(c, walls(w, h, d));
      }
    }
    const c = camera();
    c.setViewOffset(960, 1280, -120, 80, 960, 1280);
    c.zoom = 2;
    c.updateProjectionMatrix();
    proveSamplesRemain(c, walls());
  });
  it('uses the union of both scenes so the closer After cannot be clipped by Before depth', () => {
    const c = camera(),
      before = [box([-800, 200, 0], [800, 2200, 50])],
      after = [box([-150, 1000, 2900], [150, 1400, 2950])];
    const a = fitSourceDepthClip(c, before)!;
    const b = fitSourceDepthClip(c, [...before, ...after])!;
    expect(b.nearMm).toBeLessThan(a.nearMm);
    proveSamplesRemain(c, [...before, ...after]);
  });
  it('ignores invalid and offscreen bounds, preserves input boxes, and safely keeps an empty-view camera', () => {
    const c = camera(),
      valid = walls(),
      baseline = valid.map((b) => b.clone());
    const a = fitSourceDepthClip(c, valid)!;
    const b = fitSourceDepthClip(c, [
      ...valid,
      new Box3(),
      box([NaN, 0, 0], [NaN, 1, 1]),
      box([1e7, 0, -1e7], [1e7 + 1, 1, -1e7 + 1]),
    ])!;
    expect(b.nearMm).toBe(a.nearMm);
    expect(b.farMm).toBe(a.farMm);
    expect(valid).toEqual(baseline);
    const empty = camera(),
      prior = empty.projectionMatrix.clone();
    expect(fitSourceDepthClip(empty, [box([-1, 0, 5000], [1, 10, 5100])])).toBeUndefined();
    expect(empty.projectionMatrix).toEqual(prior);
  });
  it('collects visible derived mesh bounds without editing geometry/transform/material or hidden objects', () => {
    const group = new Group(),
      geometry = new BoxGeometry(30, 50, 1),
      material = new MeshStandardMaterial();
    const mesh = new Mesh(geometry, material),
      hidden = new Mesh(geometry, material);
    hidden.visible = false;
    group.add(mesh, hidden);
    mesh.position.set(400, 500, 600);
    mesh.rotation.y = 0.6;
    group.updateMatrixWorld(true);
    const p = Array.from(geometry.attributes.position.array),
      snapshot = mesh.toJSON();
    const bounds = visibleMeshBounds([group]);
    expect(bounds).toHaveLength(1);
    expect(bounds[0].getSize(new Vector3()).x).toBeGreaterThan(20);
    expect(Array.from(geometry.attributes.position.array)).toEqual(p);
    expect(mesh.toJSON()).toEqual(snapshot);
    geometry.dispose();
    material.dispose();
  });
});
