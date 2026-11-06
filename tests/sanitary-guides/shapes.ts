/**
 * Guide shapes for the sanitary-ware classes the app's standard models and the direction-photo trial's
 * shapes (tests/direction-photo-methods/shapes.ts) do not draw: a low-tank one-piece and a tankless
 * bowl, a squat pan, more countertop and wall basins, semi-pedestal and pedestal basins without a tap,
 * an undermount bowl, a utility sink, urinals and freestanding baths. Plain primitives in
 * createTemplateModel's frame (millimetres, x across, y up from 0, z front +z to back −z, the wall),
 * fitted to the exact box. Never part of the app; classes.ts says which product looks like which.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
  SphereGeometry,
  Vector2,
} from 'three';
import {
  dShape,
  fitToBox,
  loft,
  openBasin,
  prism,
  roundedRect,
  roundedRectPoints,
  type Outline,
} from '../direction-photo-methods/shapes';

export const SANITARY_SHAPES = [
  'toilet-low-tank',
  'toilet-bowl',
  'squat-pan',
  'vessel-round',
  'vessel-bowl',
  'vessel-oval',
  'wall-towelbar',
  'wall-box-under',
  'counter-deck-right',
  'semi-square',
  'semi-skirt-round',
  'semi-skirt-rect',
  'pedestal-oval',
  'pedestal-rect',
  'undermount',
  'utility-sink',
  'urinal-floor',
  'urinal-floor-sensor',
  'urinal-wall',
  'bath-egg',
  'bath-rect',
  'bath-slipper',
  'bath-clawfoot',
] as const;
export type SanitaryShape = (typeof SANITARY_SHAPES)[number];

/** An ellipse in plan (x across, z front +), as a three Shape or Path (its y is −z). */
function ellipse(rx: number, rz: number, cx = 0, cz = 0, path: Shape | Path = new Shape()) {
  path.absellipse(cx, -cz, rx, rz, 0, Math.PI * 2, false, 0);
  return path;
}
/** A U in plan, open at the front: a rounded back, walls `t` thick (urinals). */
function uShape(w: number, d: number, r: number, t: number) {
  const s = new Shape();
  const front = -d / 2,
    back = d / 2; // three's y: the front (+z) is −d/2
  s.moveTo(w / 2, front);
  s.lineTo(w / 2, back - r);
  s.absarc(w / 2 - r, back - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, back);
  s.absarc(-w / 2 + r, back - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, front);
  s.lineTo(-w / 2 + t, front);
  s.lineTo(-w / 2 + t, back - r);
  s.absarc(-w / 2 + r, back - r, r - t, Math.PI, Math.PI / 2, true);
  s.lineTo(w / 2 - r, back - t);
  s.absarc(w / 2 - r, back - r, r - t, Math.PI / 2, 0, true);
  s.lineTo(w / 2 - t, front);
  s.lineTo(w / 2, front);
  return s;
}

/** A trial guide shape for a class, fitted to the box w × h × d. */
export function createSanitaryShape(
  shape: SanitaryShape,
  [w, h, d]: readonly [number, number, number],
): Group {
  const group = new Group();
  const ceramic = new MeshStandardMaterial({ color: '#d6d6d6', roughness: 0.4, metalness: 0 });
  const seat = new MeshStandardMaterial({ color: '#e9e9e9', roughness: 0.3, metalness: 0 });
  const shaded = new MeshStandardMaterial({ color: '#8a8a8a', roughness: 0.6, metalness: 0 });
  const metal = new MeshStandardMaterial({ color: '#cccccc', roughness: 0.3, metalness: 0.8 });
  const add = <T extends Mesh>(mesh: T) => (group.add(mesh), mesh);
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, m = ceramic) => {
    const mesh = add(new Mesh(new BoxGeometry(sx, sy, sz), m));
    mesh.position.set(x, y, z);
    return mesh;
  };
  const slab = (outline: Shape | Path, y0: number, y1: number, m = ceramic, z = 0) => {
    const mesh = add(prism(outline as Shape, y0, y1, m));
    mesh.position.z = z;
    return mesh;
  };
  /** A turned body: `profile` [radius 0–0.5, height 0–1] around y, scaled to sx × (y1 − y0) × sz. */
  const lathe = (
    profile: [number, number][],
    y0: number,
    y1: number,
    sx: number,
    sz: number,
    z = 0,
    m = ceramic,
  ) => {
    const mesh = add(
      new Mesh(
        new LatheGeometry(
          profile.map(([r, y]) => new Vector2(r, y)),
          72,
        ),
        m,
      ),
    );
    mesh.scale.set(sx, y1 - y0, sz);
    mesh.position.set(0, y0, z);
    mesh.rotation.y = Math.PI; // the lathe's seam (at +z) to the back, out of the front and side views
    return mesh;
  };
  const rod = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number) => {
    const length = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const mesh = add(new Mesh(new CylinderGeometry(r, r, length, 16), metal));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (Math.abs(x1 - x0) > 1e-6) mesh.rotation.z = Math.PI / 2;
    else if (Math.abs(z1 - z0) > 1e-6) mesh.rotation.x = Math.PI / 2;
    return mesh;
  };
  const rect =
    (rw: number, rd: number, r: number, cx = 0, cz = 0): Outline =>
    (inset) =>
      roundedRect(
        rw - 2 * inset,
        rd - 2 * inset,
        Math.max(2, r - inset),
        cx,
        cz,
        inset ? new Path() : new Shape(),
      );
  const oval =
    (rw: number, rd: number, cx = 0, cz = 0): Outline =>
    (inset) =>
      ellipse(rw / 2 - inset, rd / 2 - inset, cx, cz, inset ? new Path() : new Shape());
  /** A bowl's turned shell: outside from a foot up to the rim, inside back down to a floor. */
  const BOWL: [number, number][] = [
    [0, 0],
    [0.27, 0],
    [0.3, 0.05],
    [0.41, 0.35],
    [0.48, 0.75],
    [0.5, 1],
    [0.47, 1],
    [0.44, 0.75],
    [0.36, 0.38],
    [0.22, 0.18],
    [0, 0.16],
  ];

  switch (shape) {
    // ---------- toilets ----------
    case 'toilet-low-tank': {
      // A one-piece whose cistern is a low block behind the seat, barely above the closed lid.
      const skirt = add(new Mesh(new CylinderGeometry(0.5, 0.4, 1, 64, 1, false), ceramic));
      skirt.scale.set(w * 0.96, h * 0.78, d * 0.78);
      skirt.position.set(0, h * 0.39, d * 0.1);
      slab(ellipse(w * 0.49, d * 0.39, 0, d * 0.1), h * 0.78, h * 0.82, seat);
      slab(ellipse(w * 0.49, d * 0.38, 0, d * 0.11), h * 0.82, h * 0.88, seat);
      slab(roundedRect(w * 0.86, d * 0.3, w * 0.08, 0, -d * 0.35), 0, h, ceramic);
      break;
    }
    case 'toilet-bowl': {
      // A tankless bowl (a flush valve on the wall feeds it): foot, bowl, seat and closed lid only.
      const foot = add(new Mesh(new CylinderGeometry(0.5, 0.36, 1, 48), ceramic));
      foot.scale.set(w * 0.62, h * 0.62, d * 0.6);
      foot.position.set(0, h * 0.31, -d * 0.12);
      lathe(BOWL.slice(0, 6).concat([[0, 1]]), h * 0.5, h * 0.84, w, d * 0.9, d * 0.04);
      slab(ellipse(w * 0.5, d * 0.45, 0, d * 0.04), h * 0.84, h * 0.9, seat);
      slab(ellipse(w * 0.5, d * 0.44, 0, d * 0.05), h * 0.9, h, seat);
      break;
    }
    case 'squat-pan': {
      // A long pan set into the floor, its hood raised at the front end.
      openBasin(rect(w, d, w * 0.48), 0, h * 0.62, w * 0.1, h * 0.45, ceramic, group);
      const hood = add(new Mesh(new SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), ceramic));
      hood.scale.set(w * 0.4, h * 0.38, d * 0.15);
      hood.position.set(0, h * 0.62, d * 0.32);
      break;
    }
    // ---------- countertop and wall basins ----------
    case 'vessel-round':
      openBasin(oval(w, d), 0, h, Math.min(w, d) * 0.03, h * 0.82, ceramic, group);
      break;
    case 'vessel-bowl':
      lathe(BOWL, 0, h, w, d);
      break;
    case 'vessel-oval':
      lathe(
        [
          [0, 0],
          [0.3, 0],
          [0.33, 0.04],
          [0.44, 0.32],
          [0.5, 0.85],
          [0.5, 1],
          [0.47, 1],
          [0.43, 0.7],
          [0.3, 0.3],
          [0, 0.24],
        ],
        0,
        h,
        w,
        d,
      );
      break;
    case 'wall-towelbar': {
      // A rectangular basin with a towel rail round its front and sides, under the rim.
      openBasin(
        rect(w * 0.92, d * 0.94, Math.min(w, d) * 0.06, 0, -d * 0.03),
        h * 0.3,
        h,
        w * 0.03,
        h * 0.5,
        ceramic,
        group,
      );
      const y = h * 0.03,
        r = Math.max(4, h * 0.03),
        x = w / 2 - r,
        z = d / 2 - r;
      rod(-x, y, z, x, y, z, r);
      for (const side of [-1, 1]) {
        rod(side * x, y, -d / 2, side * x, y, z, r);
        rod(side * x, y, -d * 0.2, side * x, h * 0.32, -d * 0.2, r);
      }
      break;
    }
    case 'wall-box-under': {
      // A basin slab over an open box of the same width.
      const t = Math.min(h * 0.07, 20);
      openBasin(rect(w, d, 8), h * 0.55, h, w * 0.04, h * 0.3, ceramic, group);
      box(0, t / 2, 0, w, t, d);
      for (const side of [-1, 1]) box(side * (w / 2 - t / 2), h * 0.275, 0, t, h * 0.55, d);
      box(0, h * 0.275, -d / 2 + t / 2, w, h * 0.55, t);
      break;
    }
    case 'counter-deck-right': {
      // A thick slab, its basin sunk into the left part and a flat deck on the right, a low upstand behind.
      const top = h * 0.72;
      slab(roundedRect(w, d * 0.94, 6, 0, d * 0.03), 0, top * 0.3);
      const upper = roundedRect(w, d * 0.94, 6, 0, d * 0.03) as Shape;
      upper.holes.push(roundedRect(w * 0.42, d * 0.62, 30, -w * 0.22, d * 0.06, new Path()));
      slab(upper, top * 0.3, top);
      box(0, h / 2, -d * 0.47, w, h, d * 0.06);
      break;
    }
    // ---------- semi-pedestal, pedestal ----------
    case 'semi-square': {
      // A rounded box against the wall, slightly narrower at the foot, the bowl in its top.
      const r = Math.min(w, d) * 0.14;
      add(
        loft(
          roundedRectPoints(w * 0.9, d * 0.86, r, -d * 0.07),
          roundedRectPoints(w, d, r),
          0,
          h * 0.6,
          ceramic,
        ),
      );
      openBasin(rect(w, d, r), h * 0.6, h, Math.min(w, d) * 0.05, h * 0.36, ceramic, group);
      break;
    }
    case 'semi-skirt-round':
    case 'semi-skirt-rect': {
      // A wide basin over a narrower half pedestal (a skirt that hides the trap) against the wall.
      const round = shape === 'semi-skirt-round';
      const top = h * 0.62;
      if (round) {
        // A D-shaped basin flat against the wall, on a narrower D-shaped skirt also against the wall.
        const basinOutline: Outline = (inset) => dShape(w, d, inset, inset ? new Path() : new Shape());
        openBasin(basinOutline, top, h, Math.min(w, d) * 0.05, (h - top) * 0.75, ceramic, group);
        const skirt = slab(dShape(w * 0.56, d * 0.72, 0), 0, top + 1);
        skirt.position.z = -d * 0.14;
      } else {
        openBasin(rect(w, d, Math.min(w, d) * 0.08), top, h, w * 0.04, (h - top) * 0.7, ceramic, group);
        add(
          loft(
            roundedRectPoints(w * 0.66, d * 0.6, 10, -d * 0.2),
            roundedRectPoints(w * 0.7, d * 0.66, 10, -d * 0.17),
            0,
            top,
            ceramic,
          ),
        );
      }
      break;
    }
    case 'pedestal-oval':
    case 'pedestal-rect': {
      // A basin on a full pedestal, no tap (the products are sold without one).
      const top = h * 0.74;
      if (shape === 'pedestal-oval') {
        lathe(
          [
            [0, 0],
            [0.3, 0],
            [0.42, 0.3],
            [0.5, 0.85],
            [0.5, 1],
            [0.46, 1],
            [0.42, 0.6],
            [0, 0.45],
          ],
          top,
          h,
          w,
          d,
          d * 0.03,
        );
        box(0, h * 0.975, -d * 0.34, w * 0.5, h * 0.05, d * 0.14); // the tap deck at the back
      } else {
        add(
          loft(
            roundedRectPoints(w * 0.66, d * 0.62, 20, -d * 0.04),
            roundedRectPoints(w, d, 24),
            top,
            h * 0.82,
            ceramic,
          ),
        );
        openBasin(rect(w, d, 24), h * 0.82, h, w * 0.05, h * 0.13, ceramic, group);
      }
      add(
        loft(
          roundedRectPoints(w * 0.36, d * 0.44, w * 0.12, -d * 0.12, 8),
          roundedRectPoints(w * 0.28, d * 0.36, w * 0.1, -d * 0.12, 8),
          0,
          top + h * 0.02,
          ceramic,
        ),
      );
      break;
    }
    case 'undermount':
      // A bowl hung under a counter: its flat flange at the top, the bowl below it.
      lathe(
        [
          [0, 0],
          [0.26, 0],
          [0.38, 0.32],
          [0.42, 0.9],
          [0.5, 0.9],
          [0.5, 1],
          [0.4, 1],
          [0.37, 0.4],
          [0.24, 0.12],
          [0, 0.1],
        ],
        0,
        h,
        w,
        d,
      );
      break;
    case 'utility-sink': {
      // A deep wall sink with a high splashback, its trap below.
      const z = d * 0.07;
      openBasin(rect(w, d * 0.86, 20, 0, z), h * 0.3, h * 0.72, w * 0.05, h * 0.36, ceramic, group);
      box(0, h * 0.84, -d / 2 + d * 0.07, w, h * 0.32, d * 0.14);
      const trap = add(new Mesh(new CylinderGeometry(w * 0.05, w * 0.05, h * 0.3, 24), ceramic));
      trap.position.set(0, h * 0.15, z - d * 0.05);
      break;
    }
    // ---------- urinals ----------
    case 'urinal-floor':
    case 'urinal-floor-sensor': {
      // A tall floor urinal: a solid foot, then walls round a front opening, open at the top front.
      const top = shape === 'urinal-floor-sensor' ? h * 0.9 : h;
      const r = Math.min(w, d) * 0.4;
      slab(roundedRect(w, d, r), 0, top * 0.14);
      slab(uShape(w, d, r, Math.min(w, d) * 0.1), top * 0.14, top);
      slab(roundedRect(w, d * 0.45, r * 0.4, 0, -d * 0.275), top * 0.92, top);
      if (top < h) slab(roundedRect(w * 0.86, d * 0.5, 20, 0, -d * 0.2), top, h);
      break;
    }
    case 'urinal-wall': {
      // A wall urinal: half an egg on the wall, its opening a darker oval on the front.
      // three's half sphere (phi 0 to π) is the z ≥ 0 half: the front, its flat side on the wall.
      const shell = add(new Mesh(new SphereGeometry(1, 48, 32, 0, Math.PI), ceramic));
      shell.scale.set(w / 2, h / 2, d);
      shell.position.set(0, h / 2, -d / 2);
      const opening = add(new Mesh(new SphereGeometry(1, 48, 32, 0, Math.PI), shaded));
      // Deeper than the shell, so its front shows through as a large oval (the opening).
      opening.scale.set(w * 0.3, h * 0.34, d * 1.1);
      opening.position.set(0, h * 0.45, -d / 2);
      break;
    }
    // ---------- freestanding baths ----------
    case 'bath-egg':
      lathe(
        [
          [0, 0],
          [0.34, 0],
          [0.38, 0.12],
          [0.46, 0.55],
          [0.5, 1],
          [0.485, 1],
          [0.445, 0.55],
          [0.36, 0.18],
          [0, 0.13],
        ],
        0,
        h,
        w,
        d,
      );
      break;
    case 'bath-rect':
      add(
        loft(
          roundedRectPoints(w * 0.96, d * 0.94, d * 0.1),
          roundedRectPoints(w, d, d * 0.1),
          0,
          h * 0.12,
          ceramic,
        ),
      );
      openBasin(rect(w, d, d * 0.1), h * 0.12, h, d * 0.05, h * 0.78, ceramic, group);
      break;
    case 'bath-slipper':
    case 'bath-clawfoot': {
      // An oval tub whose rim rises toward one end (the left, x < 0); the clawfoot one on four feet.
      const feet = shape === 'bath-clawfoot';
      const y0 = feet ? h * 0.16 : 0;
      const tub = lathe(
        [
          [0, 0],
          [0.4, 0],
          [0.44, 0.12],
          [0.49, 0.6],
          [0.5, 1],
          [0.485, 1],
          [0.47, 0.6],
          [0.39, 0.16],
          [0, 0.13],
        ],
        y0,
        h,
        w,
        d,
      );
      const position = tub.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const rise = Math.pow(Math.min(1, Math.max(0, 0.5 - x)), 1.6); // 1 at the left end, 0 at the right
        position.setY(i, position.getY(i) * (0.72 + 0.28 * rise));
      }
      position.needsUpdate = true;
      if (feet)
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) {
            const foot = add(new Mesh(new CylinderGeometry(w * 0.025, w * 0.018, y0 * 1.1, 16), metal));
            foot.position.set(sx * w * 0.32, (y0 * 1.1) / 2, sz * d * 0.26);
          }
      break;
    }
  }
  return fitToBox(group, [w, h, d]);
}
