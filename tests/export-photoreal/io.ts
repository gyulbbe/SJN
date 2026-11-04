/**
 * Reading and writing the trial's scene payloads and results (node): PNGs as RGBA pixels (sharp), the
 * face masks, room layers and product crops as JSON with their typed arrays in .bin files beside.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Pixels, RegionMask } from '../../src/lib/ai-export/color';
import type { RoomLayers } from '../../src/lib/ai-export/composite';
import type { ProductCrop } from '../../src/lib/ai-export/refine';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';

/** A method's result for one scene and seed, shared by all rounds (path without extension). */
export const resultBase = (method: string, scene: string, seed: number) =>
  join(RESULTS as string, method, `${scene}-${seed}`);

export async function readPng(file: string | Buffer): Promise<Pixels> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
export async function writePng(file: string, image: Pixels) {
  await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toFile(file);
}
export async function pngBuffer(image: Pixels): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Typed arrays leave the page as base64 strings tagged with their kind. */
export type Packed = { $typed: 'u8' | 'u8c' | 'f32'; base64: string };
const isPacked = (value: unknown): value is Packed =>
  !!value && typeof value === 'object' && '$typed' in (value as Record<string, unknown>);
export function unpack<T>(value: unknown): T {
  if (isPacked(value)) {
    const bytes = Buffer.from(value.base64, 'base64');
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (value.$typed === 'u8') return copy as T;
    if (value.$typed === 'u8c') return new Uint8ClampedArray(copy.buffer) as T;
    return new Float32Array(copy.buffer) as T;
  }
  if (Array.isArray(value)) return value.map((v) => unpack(v)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)])) as T;
  return value as T;
}
/** Typed arrays to .bin files next to the JSON (keys joined by dots), the rest as JSON. */
export function saveTyped(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const walk = (v: unknown, path: string): unknown => {
    if (v instanceof Uint8Array || v instanceof Uint8ClampedArray || v instanceof Float32Array) {
      const file = `${name}.${path}.bin`;
      writeFileSync(join(dir, file), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      return {
        $file: file,
        $typed: v instanceof Float32Array ? 'f32' : v instanceof Uint8ClampedArray ? 'u8c' : 'u8',
      };
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}${i}.`));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${path}${k}`)]));
    return v;
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(walk(unpack(value), ''), null, 1));
}
export function loadTyped<T>(dir: string, name: string): T {
  const walk = (v: unknown): unknown => {
    if (v && typeof v === 'object' && '$file' in (v as Record<string, unknown>)) {
      const { $file, $typed } = v as { $file: string; $typed: Packed['$typed'] };
      const bytes = readFileSync(join(dir, $file));
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return $typed === 'u8'
        ? copy
        : $typed === 'u8c'
          ? new Uint8ClampedArray(copy.buffer)
          : new Float32Array(copy.buffer);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))) as T;
}

/** A scene's folder: development scenes always, held-out ones only when the run says --holdout. */
export function sceneDir(id: string, holdout = process.argv.includes('--holdout')): string {
  const dev = join(SCENES as string, id);
  if (existsSync(dev)) return dev;
  const kept = join(HOLDOUT as string, id);
  if (existsSync(kept)) {
    if (!holdout) throw new Error(`${id} is a held-out scene; it opens only in round 6 (--holdout)`);
    return kept;
  }
  throw new Error(`no scene ${id}; run scenes.ts first`);
}
export type ScenePayload = {
  dir: string;
  capture: Pixels;
  mask: RegionMask;
  layers?: RoomLayers;
  crops?: ProductCrop[];
};
export async function loadScene(id: string): Promise<ScenePayload> {
  const dir = sceneDir(id);
  return {
    dir,
    capture: await readPng(join(dir, 'capture.png')),
    mask: loadTyped<RegionMask>(dir, 'mask'),
    layers: existsSync(join(dir, 'layers.json')) ? loadTyped<RoomLayers>(dir, 'layers') : undefined,
    crops: existsSync(join(dir, 'crops.json')) ? loadTyped<ProductCrop[]>(dir, 'crops') : undefined,
  };
}
