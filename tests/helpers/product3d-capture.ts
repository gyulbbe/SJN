/**
 * Browser-side before/after capture shared by tests/product3d-quality-browser.ts and
 * tests/product3d-batch-browser.ts. Before = saved RGB as reconstructed; after = lighting
 * correction + automatic upright, i.e. what a new reconstruction opens with.
 */
import { ProductRenderer } from '../../src/lib/product3d/renderer';
import { createDefaultPose } from '../../src/lib/product3d/pose';
import { estimateUprightQuaternion } from '../../src/lib/product3d/upright';
import type { ProductMesh } from '../../src/lib/product3d/state-types';

type Quaternion = [number, number, number, number];
export interface ComparisonShot {
  key: string;
  png: Blob;
  luminance: { mean: number; spread: number };
}

/** The default camera turned around world +z (Hamilton product qz * q). */
function turn(degrees: number): Quaternion {
  const [x, y, z, w] = createDefaultPose().cameraQuaternion;
  const h = (degrees * Math.PI) / 360;
  const [qx, qy, qz, qw] = [0, 0, Math.sin(h), Math.cos(h)];
  return [
    qw * x + qx * w + qy * z - qz * y,
    qw * y - qx * z + qy * w + qz * x,
    qw * z + qx * y - qy * x + qz * w,
    qw * w - qx * x - qy * y - qz * z,
  ];
}

async function luminance(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const probe = document.createElement('canvas');
  probe.width = bitmap.width;
  probe.height = bitmap.height;
  const ctx = probe.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
  const values: number[] = [];
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i + 3] > 200)
      values.push(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, spread };
}

export async function captureComparison(product: ProductMesh, angles = [0, 45, 90]) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const renderer = new ProductRenderer(canvas, product);
  try {
    renderer.resize(512, 512, 1);
    const started = performance.now();
    const upright = estimateUprightQuaternion(product.positions);
    const uprightMs = performance.now() - started;
    const shots: ComparisonShot[] = [];
    for (const variant of ['before', 'after'] as const) {
      renderer.setShading(variant === 'after' ? 'lit' : 'baked');
      for (const angle of angles) {
        renderer.setPose({
          objectQuaternion: variant === 'after' ? upright : [0, 0, 0, 1],
          cameraQuaternion: turn(angle),
          zoom: 1,
        });
        const { blob } = await renderer.capture();
        shots.push({ key: `${variant}-${angle}`, png: blob, luminance: await luminance(blob) });
      }
    }
    return { shots, upright, uprightMs };
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}

export function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
