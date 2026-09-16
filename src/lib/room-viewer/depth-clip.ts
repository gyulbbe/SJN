import { Box3, Frustum, Mesh, Plane, Vector3, type Object3D, type PerspectiveCamera } from 'three';

export type SourceDepthClip = {
  nearMm: number;
  farMm: number;
  minimumVisibleDepthMm: number;
  maximumVisibleDepthMm: number;
  visibleBounds: number;
  testedBounds: number;
};

// Corner order is x, then y, then z. Include degenerate boxes: wall/neutral faces are planar.
const BOX_FACES = [
  [0, 1, 3, 2],
  [4, 6, 7, 5],
  [0, 4, 5, 1],
  [2, 3, 7, 6],
  [0, 2, 6, 4],
  [1, 5, 7, 3],
];
function clipPolygon(points: Vector3[], plane: Plane): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const da = plane.distanceToPoint(a),
      db = plane.distanceToPoint(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) out.push(a.clone().lerp(b, da / (da - db)));
  }
  return out;
}

/**
 * Fit depth precision to visible bounds in one shared Before/After camera.
 * Only near/far change: saved optics, XY projection, material/shadow flags and geometry stay intact.
 * Side-plane clipping is essential when the camera is inside the room or after orbit/pan.
 * A camera inside a mesh bound conservatively keeps the original 0.1mm near plane.
 */
export function fitSourceDepthClip(
  camera: PerspectiveCamera,
  bounds: readonly Box3[],
): SourceDepthClip | undefined {
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(camera.projectionMatrix);
  const planes = [...frustum.planes.slice(0, 4), new Plane(new Vector3(0, 0, -1), 0)];
  let minimum = Infinity,
    maximum = 0,
    visibleBounds = 0,
    testedBounds = 0;
  for (const box of bounds) {
    if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) continue;
    testedBounds++;
    const vertices = [box.min.x, box.max.x].flatMap((x) =>
      [box.min.y, box.max.y].flatMap((y) =>
        [box.min.z, box.max.z].map((z) => new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)),
      ),
    );
    let visible = false;
    for (const face of BOX_FACES) {
      let polygon = face.map((i) => vertices[i]);
      for (const plane of planes) {
        polygon = clipPolygon(polygon, plane);
        if (!polygon.length) break;
      }
      for (const point of polygon) {
        const depth = Math.max(0, -point.z);
        visible = true;
        minimum = Math.min(minimum, depth);
        maximum = Math.max(maximum, depth);
      }
    }
    if (visible) {
      visibleBounds++;
      if (box.containsPoint(camera.position)) minimum = 0;
    }
  }
  if (!visibleBounds || !Number.isFinite(minimum) || maximum <= 0) return;
  camera.near = Math.max(0.1, minimum * 0.25);
  camera.far = Math.max(camera.near + 1, maximum * 1.05);
  camera.updateProjectionMatrix();
  return {
    nearMm: camera.near,
    farMm: camera.far,
    minimumVisibleDepthMm: minimum,
    maximumVisibleDepthMm: maximum,
    visibleBounds,
    testedBounds,
  };
}

/** Derived bounds only; no asset writes or mutation of the input scene/mesh buffers. */
export function visibleMeshBounds(roots: readonly Object3D[]): Box3[] {
  const boxes: Box3[] = [];
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = node.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (geometry.boundingBox) boxes.push(geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));
    });
  }
  return boxes;
}
