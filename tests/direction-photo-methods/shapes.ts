/**
 * Trial-only guide shapes for the basins the app's standard model does not draw (B2 in
 * docs/direction-photo-methods-results-20261105.md): vessel basins, a counter basin with an open shelf,
 * floor columns, a stand with a bowl, semi-pedestal basins and a cube. Browser or Node (three only, no
 * DOM). Same frame as createTemplateModel: millimetres, x across (centred), y up from 0, z front (+z) to
 * back (−z, the wall), the whole product inside width × height × depth. Never part of the app.
 */
import {
  BoxGeometry,
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
  SphereGeometry,
} from 'three';
import type { B2Shape } from './products';

type Outline = (inset: number) => Shape | Path;

/** A rounded rectangle in plan (x across, z front +), centred, as a three Shape (its y is −z). */
function roundedRect(w: number, d: number, r: number, cx = 0, cz = 0, path: Shape | Path = new Shape()) {
  const x0 = cx - w / 2,
    x1 = cx + w / 2,
    y0 = -(cz + d / 2),
    y1 = -(cz - d / 2);
  const k = Math.max(0.01, Math.min(r, w / 2 - 0.01, d / 2 - 0.01));
  path.moveTo(x0 + k, y0);
  path.lineTo(x1 - k, y0);
  path.quadraticCurveTo(x1, y0, x1, y0 + k);
  path.lineTo(x1, y1 - k);
  path.quadraticCurveTo(x1, y1, x1 - k, y1);
  path.lineTo(x0 + k, y1);
  path.quadraticCurveTo(x0, y1, x0, y1 - k);
  path.lineTo(x0, y0 + k);
  path.quadraticCurveTo(x0, y0, x0 + k, y0);
  return path;
}
/** A D shape in plan: square at the back (the wall), a half circle at the front. */
function dShape(w: number, d: number, inset: number, path: Shape | Path = new Shape()) {
  const r = w / 2 - inset;
  const back = -(-d / 2 + inset); // three y of the back edge (z = −d/2)
  const centre = -(d / 2 - inset - r); // the half circle's centre (z = d/2 − inset − r)
  path.moveTo(-r, back);
  path.lineTo(r, back);
  path.lineTo(r, centre);
  // Clockwise in three's plan (its y is −z): the half circle bulges to the front (+z).
  path.absarc(0, centre, r, 0, Math.PI, true);
  path.lineTo(-r, back);
  return path;
}

/** A prism of a plan shape from y0 to y1 (holes kept). */
function prism(shape: Shape, y0: number, y1: number, material: MeshStandardMaterial) {
  const geometry = new ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 24 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y0, 0);
  return new Mesh(geometry, material);
}
/** A body whose plan outline goes from `bottom` to `top` (same point count), closed at both ends. */
function loft(
  bottom: [number, number][],
  top: [number, number][],
  y0: number,
  y1: number,
  material: MeshStandardMaterial,
) {
  const n = bottom.length;
  const positions: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(
      [bottom[i][0], y0, bottom[i][1]],
      [bottom[j][0], y0, bottom[j][1]],
      [top[j][0], y1, top[j][1]],
      [top[i][0], y1, top[i][1]],
    );
  }
  const cb = bottom.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const ct = top.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    positions.push(cb[0], y0, cb[1], bottom[j][0], y0, bottom[j][1], bottom[i][0], y0, bottom[i][1]);
    positions.push(ct[0], y1, ct[1], top[i][0], y1, top[i][1], top[j][0], y1, top[j][1]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new Mesh(geometry, material);
}
/** Points along a rounded rectangle in plan (x, z), counter-clockwise from above. */
function roundedRectPoints(w: number, d: number, r: number, cz = 0, perCorner = 6): [number, number][] {
  const k = Math.min(r, w / 2 - 0.5, d / 2 - 0.5);
  const corners: [number, number, number][] = [
    [w / 2 - k, cz + d / 2 - k, 0],
    [w / 2 - k, cz - d / 2 + k, -Math.PI / 2],
    [-w / 2 + k, cz - d / 2 + k, Math.PI],
    [-w / 2 + k, cz + d / 2 - k, Math.PI / 2],
  ];
  const points: [number, number][] = [];
  for (const [x, z, start] of corners)
    for (let i = 0; i <= perCorner; i++) {
      const a = start - (i / perCorner) * (Math.PI / 2);
      points.push([x + k * Math.cos(a), z + k * Math.sin(a)]);
    }
  return points;
}

/**
 * An open basin: walls `wall` thick round a cavity `cavity` deep, from y0 to y1, and the solid body
 * below it. `outline(inset)` draws the plan at that inset (0 the outside).
 */
function openBasin(
  outline: Outline,
  y0: number,
  y1: number,
  wall: number,
  cavity: number,
  material: MeshStandardMaterial,
  group: Group,
) {
  const floor = Math.max(y0, y1 - cavity);
  if (floor > y0) group.add(prism(outline(0) as Shape, y0, floor, material));
  const ring = outline(0) as Shape;
  ring.holes.push(outline(wall) as Path);
  group.add(prism(ring, floor, y1, material));
}

/** A trial shape as a group, in createTemplateModel's frame and box. */
export function createTrialShape(shape: B2Shape, [w, h, d]: readonly [number, number, number]): Group {
  const group = new Group();
  const ceramic = new MeshStandardMaterial({ color: '#d6d6d6', roughness: 0.4, metalness: 0 });
  const add = (mesh: Mesh) => group.add(mesh);
  switch (shape) {
    case 'vessel-rect':
    case 'vessel-soft': {
      const soft = shape === 'vessel-soft';
      const r = soft ? Math.min(w, d) * 0.22 : Math.min(w, d) * 0.04;
      const wall = soft ? Math.min(w, d) * 0.03 : Math.min(w, d) * 0.035;
      const outline: Outline = (inset) =>
        roundedRect(
          w - 2 * inset,
          d - 2 * inset,
          Math.max(2, r - inset),
          0,
          0,
          inset ? new Path() : new Shape(),
        );
      openBasin(outline, 0, h, wall, h * 0.82, ceramic, group);
      break;
    }
    case 'counter-shelf-right':
    case 'counter-shelf-left': {
      // A long slab: a basin over 62% of the width, an open shelf under a deck over the rest.
      const sign = shape === 'counter-shelf-right' ? 1 : -1;
      const basinW = w * 0.62,
        shelfW = w - basinW;
      const bx = -sign * (w / 2 - basinW / 2),
        sx = sign * (w / 2 - shelfW / 2);
      const wall = Math.min(d, h) * 0.08;
      const basinOutline: Outline = (inset) =>
        roundedRect(
          basinW - 2 * inset,
          d - 2 * inset,
          Math.max(2, 6 - inset),
          bx,
          0,
          inset ? new Path() : new Shape(),
        );
      openBasin(basinOutline, 0, h, wall * 1.4, h * 0.7, ceramic, group);
      const t = Math.min(h * 0.12, 22);
      const box = (x: number, y: number, z: number, sx2: number, sy: number, sz: number) => {
        const mesh = new Mesh(new BoxGeometry(sx2, sy, sz), ceramic);
        mesh.position.set(x, y, z);
        add(mesh);
      };
      box(sx, h - t / 2, 0, shelfW, t, d); // the deck
      box(sx, t / 2, 0, shelfW, t, d); // the shelf's floor
      box(sx + sign * (shelfW / 2 - t / 2), h / 2, 0, t, h, d); // the end wall
      box(sx, h / 2, -d / 2 + t / 2, shelfW, h, t); // the back
      break;
    }
    case 'column-rect': {
      const outline: Outline = (inset) =>
        roundedRect(
          w - 2 * inset,
          d - 2 * inset,
          Math.max(2, Math.min(w, d) * 0.06 - inset),
          0,
          0,
          inset ? new Path() : new Shape(),
        );
      openBasin(outline, 0, h, Math.min(w, d) * 0.06, h * 0.13, ceramic, group);
      break;
    }
    case 'column-round': {
      const outline: Outline = (inset) => {
        const path = inset ? new Path() : new Shape();
        path.absellipse(0, 0, w / 2 - inset, d / 2 - inset, 0, Math.PI * 2, false, 0);
        return path;
      };
      openBasin(outline, 0, h, Math.min(w, d) * 0.06, h * 0.12, ceramic, group);
      break;
    }
    case 'stand-bowl': {
      // A post on the floor, a deck from it to the far end, the end turned down; a round bowl on top.
      const postW = w * 0.42,
        deckY = h * 0.8,
        t = h * 0.05;
      const box = (x: number, y: number, z: number, sx2: number, sy: number, sz: number) => {
        const mesh = new Mesh(new BoxGeometry(sx2, sy, sz), ceramic);
        mesh.position.set(x, y, z);
        add(mesh);
      };
      box(-w / 2 + postW / 2, deckY / 2, 0, postW, deckY, d * 0.7);
      box(0, deckY + t / 2, 0, w, t, d * 0.7);
      box(w / 2 - w * 0.04, deckY - h * 0.12 + t / 2, 0, w * 0.08, h * 0.24, d * 0.7);
      const bowl = new Mesh(new SphereGeometry(1, 40, 20, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), ceramic);
      // The lower half sphere: its open rim at the top (y = h), its round bottom on the deck.
      bowl.scale.set(postW * 0.62, h - deckY - t, d * 0.42);
      bowl.position.set(-w / 2 + postW / 2, h, 0);
      add(bowl);
      break;
    }
    case 'semi-round': {
      const outline: Outline = (inset) => dShape(w, d, inset, inset ? new Path() : new Shape());
      openBasin(outline, h * 0.0, h, Math.min(w, d) * 0.05, h * 0.3, ceramic, group);
      break;
    }
    case 'semi-taper': {
      // A rectangular top over a body whose front slopes back to a smaller foot against the wall.
      const topY = h * 0.72;
      const wall = Math.min(w, d) * 0.05;
      const outline: Outline = (inset) =>
        roundedRect(
          w - 2 * inset,
          d - 2 * inset,
          Math.max(2, Math.min(w, d) * 0.1 - inset),
          0,
          0,
          inset ? new Path() : new Shape(),
        );
      openBasin(outline, topY, h, wall, h - topY, ceramic, group);
      const footD = d * 0.45;
      add(
        loft(
          roundedRectPoints(w * 0.72, footD, 20, -d / 2 + footD / 2),
          roundedRectPoints(w, d, Math.min(w, d) * 0.1),
          0,
          topY,
          ceramic,
        ),
      );
      break;
    }
    case 'cube': {
      const outline: Outline = (inset) =>
        roundedRect(
          w - 2 * inset,
          d - 2 * inset,
          Math.max(2, 8 - inset),
          0,
          0,
          inset ? new Path() : new Shape(),
        );
      openBasin(outline, 0, h, Math.min(w, d) * 0.05, h * 0.35, ceramic, group);
      break;
    }
  }
  // Fitted to the exact box, as createTemplateModel does, with the geometry baked in.
  const { min, max } = shapeExtent(group);
  const scale = [w / (max[0] - min[0]), h / (max[1] - min[1]), d / (max[2] - min[2])];
  for (const node of group.children) {
    const mesh = node as Mesh;
    mesh.updateMatrixWorld(true);
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
    mesh.geometry.translate(-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2);
    mesh.geometry.scale(scale[0], scale[1], scale[2]);
    mesh.geometry.computeVertexNormals();
  }
  group.updateMatrixWorld(true);
  return group;
}

/** A check that a shape fills its box (tests): the extent of every vertex. */
export function shapeExtent(group: Group) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  group.updateMatrixWorld(true);
  group.traverse((node) => {
    const mesh = node as Mesh;
    const positions = mesh.isMesh ? mesh.geometry.getAttribute('position') : undefined;
    if (!positions) return;
    const e = mesh.matrixWorld.elements;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i),
        y = positions.getY(i),
        z = positions.getZ(i);
      const p = [
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14],
      ];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  });
  return { min, max };
}
