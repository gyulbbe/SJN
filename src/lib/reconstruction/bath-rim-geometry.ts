/** Geometry contract of the existing standard bath, before its exact-box normalization.
 * No photo dimensions are inferred. Tests compare these planes to the actual rim meshes.
 */
export function standardBathRimGeometry(w: number, h: number, d: number) {
  const faucetSize = h * 0.11;
  const minX = Math.min(-w / 2, -w * 0.36 - faucetSize * 0.09);
  const maxX = Math.max(w / 2, -w * 0.36 + faucetSize * 0.09);
  const minZ = Math.min(-d / 2, -d * 0.405 - faucetSize * 0.17);
  const maxZ = Math.max(d / 2, -d * 0.405 + faucetSize * 0.55);
  const sx = w / (maxX - minX),
    sz = d / (maxZ - minZ);
  const centreX = (minX + maxX) / 2,
    centreZ = (minZ + maxZ) / 2;
  const heightMm = h / (0.96 + 0.11 * 0.9975);
  const xRounding = Math.min(w * 0.07, h * 0.106, d * 0.85) * 0.13;
  const zRounding = Math.min(w, h * 0.106, d * 0.08) * 0.13;
  return {
    heightMm,
    back: {
      x: -centreX * sx,
      z: (-d * 0.46 - centreZ) * sz,
      lengthMm: (w - 2 * zRounding) * sx,
      thicknessMm: (d * 0.08 - 2 * zRounding) * sz,
      yawDegrees: 0,
    },
    front: {
      x: -centreX * sx,
      z: (d * 0.46 - centreZ) * sz,
      lengthMm: (w - 2 * zRounding) * sx,
      thicknessMm: (d * 0.08 - 2 * zRounding) * sz,
      yawDegrees: 0,
    },
    left: {
      x: (-w * 0.465 - centreX) * sx,
      z: -centreZ * sz,
      lengthMm: (d * 0.85 - 2 * xRounding) * sz,
      thicknessMm: (w * 0.07 - 2 * xRounding) * sx,
      yawDegrees: 90,
    },
    right: {
      x: (w * 0.465 - centreX) * sx,
      z: -centreZ * sz,
      lengthMm: (d * 0.85 - 2 * xRounding) * sz,
      thicknessMm: (w * 0.07 - 2 * xRounding) * sx,
      yawDegrees: 90,
    },
  };
}
