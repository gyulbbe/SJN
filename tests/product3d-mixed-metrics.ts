/**
 * Numbers for the three view modes on the eight saved TripoSR meshes (test-results/product3d-batch):
 * the time to colour each mesh (Node, one thread), how far the vertices the photo does not show are
 * from the colour of the photographed big face (lightness ΔL* and distance in the a*·b* plane), and
 * how many dark marks of the photographed side are still marks. Written to
 * test-results/product3d-mixed/metrics.json.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-mixed-metrics.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { estimateAlbedo } from '../src/lib/product3d/albedo';
import { mixedSurface } from '../src/lib/product3d/mixed-color';
import {
  BATCH_MESHES,
  compareWithPhotographedSide,
  hasBatchMesh,
  readBatchMesh,
} from './helpers/mixed-metrics';

const rows: Record<string, unknown>[] = [];
console.log(
  'mesh               vertices   mixed ms | unseen ΔL*  chroma | baked ΔL*  chroma | marks kept (mixed / lit)',
);
for (const name of BATCH_MESHES.filter(hasBatchMesh)) {
  const mesh = readBatchMesh(name);
  let started = performance.now();
  const lit = estimateAlbedo(mesh.positions, mesh.indices, mesh.colors);
  const litMs = performance.now() - started;
  started = performance.now();
  const mixed = mixedSurface(mesh.positions, mesh.indices, mesh.colors).colors;
  const mixedMs = performance.now() - started;
  const a = compareWithPhotographedSide(mesh, mixed),
    b = compareWithPhotographedSide(mesh, mesh.colors),
    c = compareWithPhotographedSide(mesh, lit);
  rows.push({
    name,
    vertices: a.vertices,
    shownShare: a.shownShare,
    unseenShare: a.unseenShare,
    litMs: Math.round(litMs),
    mixedMs: Math.round(mixedMs),
    mixed: { lightness: a.lightness, chroma: a.chroma, marks: a.marks, kept: a.kept },
    lit: { lightness: c.lightness, chroma: c.chroma, kept: c.kept },
    baked: { lightness: b.lightness, chroma: b.chroma },
  });
  console.log(
    `${name.padEnd(18)} ${String(a.vertices).padStart(8)} ${String(Math.round(mixedMs)).padStart(8)}   | ${a.lightness.toFixed(1).padStart(8)} ${a.chroma.toFixed(1).padStart(7)}  | ${b.lightness.toFixed(1).padStart(8)} ${b.chroma.toFixed(1).padStart(7)} | ${(a.kept * 100).toFixed(0)}% / ${(c.kept * 100).toFixed(0)}% of ${a.marks}`,
  );
}
await mkdir('test-results/product3d-mixed', { recursive: true });
await writeFile('test-results/product3d-mixed/metrics.json', JSON.stringify(rows, null, 2));
