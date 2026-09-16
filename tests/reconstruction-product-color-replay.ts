/** Colour-only replay of preserved real primary DeepLab masks; no model, edited bounds, or invented labels. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { observeProductColor } from '../src/lib/reconstruction/product-color';
import { ADE_OBJECTS, representativeObjectColor } from '../src/lib/reconstruction/candidates';
import type { ReconstructionKind } from '../src/lib/reconstruction/types';
const root = 'test-results/reconstruction-product-color-20260914';
const output = root + '/final-observation-replay';
await mkdir(output, { recursive: true });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(root + '/manifest.json', 'utf8'));
const summary: unknown[] = [];
for (const item of manifest.cases) {
  const source =
    item.id === 'prospective-03'
      ? root + '/primary-capture/' + item.id
      : 'test-results/reconstruction-object-surfaces-20260913/labels/' + item.id;
  const reportBytes = await readFile(source + '/report.json');
  const report = JSON.parse(reportBytes.toString('utf8'));
  const pixels = await readFile(source + '/photo.rgba'),
    labels = await readFile(source + '/semantic-labels.u8');
  const input = await readFile(item.input.path);
  assert.equal(sha(input), item.input.sha256);
  assert.equal(report.inputSha256, item.input.sha256);
  assert.equal(sha(labels), report.labelSha256);
  const { width, height } = report;
  assert.equal(pixels.length, width * height * 4);
  assert.equal(labels.length, width * height);
  const rgba = new Uint8ClampedArray(pixels),
    visited = new Uint8Array(width * height);
  const entries = [];
  const start = performance.now();
  for (let origin = 0; origin < labels.length; origin++) {
    const label = labels[origin],
      kind: ReconstructionKind | undefined = ADE_OBJECTS[label] ?? (label === 11 ? 'vanity' : undefined);
    if (!kind || visited[origin]) continue;
    const component = [origin];
    visited[origin] = 1;
    for (let at = 0; at < component.length; at++) {
      const p = component[at],
        x = p % width,
        y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy,
            next = yy * width + xx;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && !visited[next] && labels[next] === label) {
            visited[next] = 1;
            component.push(next);
          }
        }
    }
    if (component.length < Math.max(12, Math.ceil(width * height * 0.00015))) continue;
    const xs = component.map((p) => p % width),
      ys = component.map((p) => Math.floor(p / width));
    const left = Math.min(...xs),
      top = Math.min(...ys),
      right = Math.max(...xs) + 1,
      bottom = Math.max(...ys) + 1;
    if (right - left < 3 || bottom - top < 3) continue;
    const stride = Math.max(1, Math.floor(component.length / 256));
    const samples = component.filter((_, i) => i % stride === 0);
    const before = representativeObjectColor(rgba, samples);
    const after = observeProductColor({ kind, rgba, width, height, pixels: component });
    const id = `object-${label}-${origin}`;
    entries.push({
      id,
      kind,
      bounds: { left: left / width, top: top / height, right: right / width, bottom: bottom / height },
      pixels: component.length,
      before,
      after,
    });
  }
  const elapsedMs = performance.now() - start;
  const directory = output + '/' + item.id;
  await mkdir(directory, { recursive: true });
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(directory + '/actual-analysis-photo.png');
  const result = {
    id: item.id,
    scope:
      'Actual primary full-photo semantic labels replay only; original photo/labels unchanged, no inference and no flip/crop ensemble. Before is legacy representativeObjectColor on same BFS samples, after is new internal-pixel policy, neither is calibrated material reflectance.',
    inputSha256: sha(input),
    reportSha256: sha(reportBytes),
    rgbaSha256: sha(pixels),
    labelSha256: sha(labels),
    width,
    height,
    elapsedMs,
    entries,
  };
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2));
  summary.push(result);
  console.log(
    JSON.stringify({
      id: item.id,
      elapsedMs,
      ceramics: entries
        .filter((e) => ['basin', 'toilet', 'vanity'].includes(e.kind))
        .sort((a, b) => b.pixels - a.pixels)
        .slice(0, 4)
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          before: e.before,
          after: e.after.color,
          source: e.after.source,
          observed: e.after.observedColor,
        })),
    }),
  );
}
await writeFile(
  output + '/summary.json',
  JSON.stringify(
    {
      sourceHash: sha(await readFile('src/lib/reconstruction/product-color.ts')),
      scope:
        'Known regression; same saved actual primary labels. Runtime is postprocessing only, not AI latency.',
      cases: summary,
    },
    null,
    2,
  ),
);
