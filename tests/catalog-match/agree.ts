/**
 * WebGPU against WASM (the plan's check): the same faces through the same model files on both paths,
 * cosine of the embeddings; and int8 (the WASM-friendly file) against q4f16 (the GPU-friendly file).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/agree.ts
 */
import { join } from 'node:path';
import { loadQueries, out } from './data';

const gpu = loadQueries(join(out, 'features', 'agree-webgpu'));
const cpu = loadQueries(join(out, 'features', 'agree-wasm'));
const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let k = 0; k < a.length; k++) d += a[k] * b[k];
  return d;
};
const rows = Math.min(gpu.rows.length, cpu.rows.length);
const result: Record<string, { min: number; mean: number }> = {};
const record = (name: string, values: number[]) => {
  result[name] = { min: Math.min(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
};
for (const model of ['dinov2-small', 'siglip2-b16'])
  for (const name of [
    `${model}-q4f16.window.pooled`,
    `${model}-q4f16.window.patchmean`,
    `${model}-q8.window.patchmean`,
  ]) {
    const a = gpu.matrix(name),
      b = cpu.matrix(name);
    if (!a || !b) continue;
    const values = Array.from({ length: rows }, (_, r) =>
      cos(a.data.subarray(r * a.dims, (r + 1) * a.dims), b.data.subarray(r * b.dims, (r + 1) * b.dims)),
    );
    record(`${name} webgpu~wasm`, values);
  }
for (const model of ['dinov2-small', 'siglip2-b16']) {
  const a = cpu.matrix(`${model}-q4f16.window.patchmean`),
    b = cpu.matrix(`${model}-q8.window.patchmean`);
  if (!a || !b) continue;
  record(
    `${model} q4f16~q8 (wasm)`,
    Array.from({ length: rows }, (_, r) =>
      cos(a.data.subarray(r * a.dims, (r + 1) * a.dims), b.data.subarray(r * b.dims, (r + 1) * b.dims)),
    ),
  );
}
console.log('rows', rows);
for (const [name, v] of Object.entries(result))
  console.log(name.padEnd(48), 'min', v.min.toFixed(4), 'mean', v.mean.toFixed(4));
