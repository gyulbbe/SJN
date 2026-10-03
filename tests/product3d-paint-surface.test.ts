import { describe, expect, it, vi } from 'vitest';
import { fitProductMesh, type ProductFit } from '../src/lib/product3d/fit';
import { paintedFrom } from '../src/lib/product3d/painted';
import { productSurface } from '../src/lib/product3d/shading';
import { prepareFittedMesh, preparePaintedMesh, prepareProductSurface } from '../src/lib/product3d/surface';
import { onFront, photoOf, sheet } from './helpers/product3d-photo-shapes';

const lineAt = (x: number): [number, number, number] =>
  Math.abs(x - 256) < 2 ? [20, 20, 20] : [215, 215, 215];

describe('preparePaintedMesh', () => {
  it('gives a new mesh that carries the photo, reads the photo once, and answers a repeat from memory', async () => {
    const mesh = sheet(0.3, 0.3, 50);
    const photo = photoOf(mesh, onFront, lineAt);
    const load = vi.fn(async () => photo);
    const first = await preparePaintedMesh(mesh, load);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.mesh).not.toBe(mesh);
    expect(paintedFrom(first.mesh)).toBeDefined();
    expect(paintedFrom(mesh)).toBeUndefined();
    // The thin line is split finer where the photo has it.
    expect(first.mesh.positions.length).toBeGreaterThan(mesh.positions.length);
    expect(first.iou).toBeGreaterThan(0.9);
    const again = await preparePaintedMesh(mesh, load);
    expect(again).toBe(first);
    // Asking with the camera that was found is answered by the same work, not a second search.
    expect(await preparePaintedMesh(mesh, load, first.camera)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('lays the photo over the original colours and the mixed ones of the new mesh only', async () => {
    const mesh = sheet(0.3, 0.3, 50);
    const photo = photoOf(mesh, onFront, () => [40, 90, 200]);
    const outcome = await preparePaintedMesh(mesh, async () => photo, onFront);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const painted = outcome.mesh;
    const centre = Math.floor(painted.positions.length / 6);
    // The model's colours are grey; the photo's blue shows through where it was read.
    expect(productSurface('baked', mesh).colors[centre * 3 + 2]).toBeCloseTo(0.8, 5);
    expect(productSurface('baked', painted).colors.some((c, i) => i % 3 === 2 && c > 0.75)).toBe(true);
    // What a worker answers is what the synchronous calculation gives (here the fallback is the same code).
    const prepared = await prepareProductSurface('mixed', painted);
    expect(prepared.colors).toBe(productSurface('mixed', painted).colors);
    expect(prepared.normals).toBeDefined();
    // The mesh without the photo is untouched.
    expect(productSurface('mixed', mesh).colors).not.toEqual(prepared.colors);
  }, 60_000);

  it('reads colours the same through a fitted copy: a fit moves the vertices, not the photo', async () => {
    const mesh = sheet(0.3, 0.3, 50);
    const photo = photoOf(mesh, onFront, () => [40, 90, 200]);
    const outcome = await preparePaintedMesh(mesh, async () => photo, onFront);
    if (outcome.status !== 'ok') throw new Error('paint failed');
    const fit: ProductFit = { upright: [0, 0, 0, 1], front: 0, size: true };
    const fitted = await prepareFittedMesh(outcome.mesh, fit, { widthMm: 300, depthMm: 600, heightMm: 900 });
    expect(fitted).not.toBe(outcome.mesh);
    expect(
      fitProductMesh(outcome.mesh, fit, { widthMm: 300, depthMm: 600, heightMm: 900 }).positions,
    ).toEqual(fitted.positions);
    expect(productSurface('baked', fitted).colors).toBe(productSurface('baked', outcome.mesh).colors);
    expect(productSurface('mixed', fitted).colors).toBe(productSurface('mixed', outcome.mesh).colors);
  }, 60_000);

  it('says why when the outline does not fit, keeps that answer, and leaves the mesh as it was', async () => {
    const mesh = sheet(0.3, 0.3, 40);
    const photo = photoOf(mesh, onFront);
    // A photo of something far off to the side and tiny.
    for (let i = 0; i < photo.data.length; i += 4) photo.data[i + 3] = 0;
    for (let y = 20; y < 140; y++) for (let x = 20; x < 140; x++) photo.data[(y * 512 + x) * 4 + 3] = 255;
    const load = vi.fn(async () => photo);
    const outcome = await preparePaintedMesh(mesh, load);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toBe('outline');
      expect(outcome.message).toContain('윤곽');
    }
    await preparePaintedMesh(mesh, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(paintedFrom(mesh)).toBeUndefined();
  }, 60_000);

  it('says so when the photo cannot be read, and tries again the next time', async () => {
    const mesh = sheet(0.3, 0.3, 20);
    let attempts = 0;
    const load = async () => {
      attempts++;
      throw new Error('not an image');
    };
    const outcome = await preparePaintedMesh(mesh, load, onFront);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'photo' });
    await preparePaintedMesh(mesh, load, onFront);
    expect(attempts).toBe(2);
  });
});
