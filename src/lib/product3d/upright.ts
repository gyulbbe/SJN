import { Quaternion, Vector3 } from 'three';

type QuaternionTuple = [number, number, number, number];

const tilt = (pitchDegrees: number, rollDegrees: number) =>
  new Quaternion()
    .setFromAxisAngle(new Vector3(0, 1, 0), (pitchDegrees * Math.PI) / 180)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (rollDegrees * Math.PI) / 180));

/**
 * Upright correction for a TripoSR mesh (+z up, source camera near +x). Sanitary ware rests on a
 * flat floor face (bottom, -z) or wall face (back, -x); when upright, many surface points lie in a
 * thin slab against those faces. Only pitch and roll within ±maxDegrees are searched, yaw is kept
 * so the product still faces the photo, and the result is used only when it clearly beats the
 * reconstruction as-is. A lumpy or round shape without such faces stays untouched, because a
 * confident-looking wrong tilt is worse than none.
 */
export function estimateUprightQuaternion(
  positions: Float32Array,
  { maxDegrees = 25, sample = 4000, slab = 0.02, minGain = 0.3, minAbsoluteGain = 0.02 } = {},
): QuaternionTuple {
  const total = positions.length / 3;
  if (total < 4) return [0, 0, 0, 1];
  const stride = Math.max(1, Math.ceil(total / sample));
  const points: Vector3[] = [];
  for (let v = 0; v < total; v += stride)
    points.push(new Vector3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
  const rotated = points.map(() => new Vector3());
  const score = (pitch: number, roll: number) => {
    const rotation = tilt(pitch, roll);
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    points.forEach((point, i) => {
      const p = rotated[i].copy(point).applyQuaternion(rotation);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });
    const bottom = slab * (maxZ - minZ),
      back = slab * (maxX - minX);
    let floor = 0,
      wall = 0;
    for (const p of rotated) {
      if (p.z - minZ < bottom) floor++;
      if (p.x - minX < back) wall++;
    }
    return (floor + wall) / rotated.length;
  };
  const identity = score(0, 0);
  let best = { pitch: 0, roll: 0, score: identity };
  const search = (center: { pitch: number; roll: number }, span: number, step: number) => {
    for (let pitch = center.pitch - span; pitch <= center.pitch + span + 1e-9; pitch += step)
      for (let roll = center.roll - span; roll <= center.roll + span + 1e-9; roll += step) {
        if (Math.abs(pitch) > maxDegrees + 1e-9 || Math.abs(roll) > maxDegrees + 1e-9) continue;
        const value = score(pitch, roll);
        if (value > best.score) best = { pitch, roll, score: value };
      }
  };
  search({ pitch: 0, roll: 0 }, maxDegrees, 5);
  search({ pitch: best.pitch, roll: best.roll }, 5, 1);
  search({ pitch: best.pitch, roll: best.roll }, 1, 0.25);
  if (best.score < identity * (1 + minGain) || best.score - identity < minAbsoluteGain) return [0, 0, 0, 1];
  const q = tilt(best.pitch, best.roll).normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  return q.toArray() as QuaternionTuple;
}
