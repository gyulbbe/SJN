/**
 * The trial's browser models, in the page (bundled by lab.ts; no AI call): CLIP ViT-B/32 ("a photo"
 * against "a 3D render", zero-shot, the image side from catalog-match) and Swin2SR x2 (tiled), both on
 * onnxruntime-web. The BiRefNet cut-out is the app's own client, loaded separately by lab.ts.
 */
import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = '/ort/';
type Session = ort.InferenceSession;
const sessions: Record<string, Promise<Session>> = {};
let provider = 'webgpu';
async function session(name: string): Promise<Session> {
  sessions[name] ??= (async () => {
    // CLIP's q8 files on WebGPU gave wrong answers (2026-11-04): the text side pooled at its start
    // token (an int64 argmax), the image side gave the same vector for different pictures. WASM is
    // exact; they are small.
    if (name.startsWith('clip-'))
      return ort.InferenceSession.create(`/models/${name}`, { executionProviders: ['wasm'] });
    try {
      return await ort.InferenceSession.create(`/models/${name}`, { executionProviders: ['webgpu'] });
    } catch {
      provider = 'wasm';
      return ort.InferenceSession.create(`/models/${name}`, { executionProviders: ['wasm'] });
    }
  })();
  return sessions[name];
}

// ---------- CLIP tokenizer (BPE with the </w> suffix, as tokenizer.json says) ----------
type Tokenizer = { vocab: Record<string, number>; ranks: Map<string, number> };
let tokenizer: Tokenizer | undefined;
const byteChars = (() => {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++)
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  return new Map(bs.map((b, i) => [b, String.fromCharCode(cs[i])]));
})();
async function loadTokenizer() {
  if (tokenizer) return tokenizer;
  const json = (await (await fetch('/models/clip-tokenizer.json')).json()) as {
    model: { vocab: Record<string, number>; merges: (string | string[])[] };
  };
  const ranks = new Map(
    json.model.merges.map((m, i) => [Array.isArray(m) ? m.join(' ') : m, i] as [string, number]),
  );
  tokenizer = { vocab: json.model.vocab, ranks };
  return tokenizer;
}
function bpe(word: string[], ranks: Map<string, number>): string[] {
  let parts = word;
  for (;;) {
    let best = -1,
      rank = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const r = ranks.get(`${parts[i]} ${parts[i + 1]}`);
      if (r !== undefined && r < rank) {
        rank = r;
        best = i;
      }
    }
    if (best < 0) return parts;
    parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
  }
}
export async function tokenize(text: string): Promise<number[]> {
  const { vocab, ranks } = await loadTokenizer();
  const normal = text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase().trim();
  const pieces = normal.match(/'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu) ?? [];
  const ids = [49406];
  for (const piece of pieces) {
    const chars = [...new TextEncoder().encode(piece)].map((b) => byteChars.get(b)!);
    chars[chars.length - 1] += '</w>';
    for (const token of bpe(chars, ranks)) {
      const id = vocab[token];
      if (id === undefined) throw new Error(`no CLIP token for ${token}`);
      ids.push(id);
    }
  }
  ids.push(49407);
  return ids;
}

// ---------- images ----------
async function pixels(url: string, size?: { width: number; height: number; square?: boolean }) {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(size?.width ?? bitmap.width, size?.height ?? bitmap.height);
  const ctx = canvas.getContext('2d')!;
  if (size?.square) {
    // CLIP's preprocessing: the shorter side to 224, the centre square.
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } else ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
const normalise = (v: Float32Array) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

let textEmbeds: { real: Float32Array; render: Float32Array } | undefined;
export const CLIP_REAL = [
  'a photo of a bathroom',
  'a real photograph of a bathroom interior',
  'a photo of a tiled bathroom taken with a camera',
];
export const CLIP_RENDER = [
  'a 3d render of a bathroom',
  'a computer graphics rendering of a bathroom interior',
  'a cgi image of a tiled bathroom',
];
async function texts(list: string[]) {
  const text = await session('clip-text.onnx');
  const sum = new Float32Array(512);
  for (const sentence of list) {
    const ids = await tokenize(sentence);
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    };
    if (text.inputNames.includes('attention_mask'))
      feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    const out = await text.run(feeds);
    const e = normalise(out.text_embeds.data as Float32Array);
    for (let i = 0; i < 512; i++) sum[i] += e[i];
  }
  return normalise(sum);
}
/** P("a photo") against P("a 3D render") for each image URL, with CLIP's logit scale 100. */
export async function clipReal(urls: string[]): Promise<{ real: number; provider: string }[]> {
  textEmbeds ??= { real: await texts(CLIP_REAL), render: await texts(CLIP_RENDER) };
  const vision = await session('clip-vision.onnx');
  const mean = [0.48145466, 0.4578275, 0.40821073],
    std = [0.26862954, 0.26130258, 0.27577711];
  const out: { real: number; provider: string }[] = [];
  for (const url of urls) {
    const image = await pixels(url, { width: 224, height: 224, square: true });
    const data = new Float32Array(3 * 224 * 224);
    for (let i = 0; i < 224 * 224; i++)
      for (let c = 0; c < 3; c++) data[c * 224 * 224 + i] = (image.data[i * 4 + c] / 255 - mean[c]) / std[c];
    const result = await vision.run({ pixel_values: new ort.Tensor('float32', data, [1, 3, 224, 224]) });
    const e = normalise(result.image_embeds.data as Float32Array);
    const dot = (t: Float32Array) => e.reduce((s, x, i) => s + x * t[i], 0);
    const a = 100 * dot(textEmbeds.real),
      b = 100 * dot(textEmbeds.render);
    out.push({ real: 1 / (1 + Math.exp(b - a)), provider: 'wasm' });
  }
  return out;
}

/** Cosine similarity of one image to each sentence (a check of the tokenizer and the two encoders). */
export async function clipSimilarities(url: string, sentences: string[]) {
  const vision = await session('clip-vision.onnx');
  const mean = [0.48145466, 0.4578275, 0.40821073],
    std = [0.26862954, 0.26130258, 0.27577711];
  const image = await pixels(url, { width: 224, height: 224, square: true });
  const data = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++)
    for (let c = 0; c < 3; c++) data[c * 224 * 224 + i] = (image.data[i * 4 + c] / 255 - mean[c]) / std[c];
  const result = await vision.run({ pixel_values: new ort.Tensor('float32', data, [1, 3, 224, 224]) });
  const e = normalise(result.image_embeds.data as Float32Array);
  const out: Record<string, number> = {};
  for (const s of sentences) {
    const t = await texts([s]);
    out[s] = +e.reduce((sum, x, i) => sum + x * t[i], 0).toFixed(4);
  }
  return { out, tokens: await tokenize(sentences[0]), provider: 'wasm' };
}

/** Swin2SR x2 on 128 px tiles (16 px overlap, centres kept); returns a PNG data URL twice the size. */
export async function upscale(url: string): Promise<{ png: string; ms: number; provider: string }> {
  const started = performance.now();
  const model = await session('swin2sr-x2.onnx');
  const image = await pixels(url);
  const { width, height } = image;
  const out = new Float32Array(3 * width * 2 * height * 2);
  const TILE = 128,
    PAD = 16;
  for (let ty = 0; ty < height; ty += TILE)
    for (let tx = 0; tx < width; tx += TILE) {
      const x0 = Math.max(0, tx - PAD),
        y0 = Math.max(0, ty - PAD);
      const x1 = Math.min(width, tx + TILE + PAD),
        y1 = Math.min(height, ty + TILE + PAD);
      // Swin2SR pads to a multiple of 8 (its window); edge pixels repeat.
      const w = Math.ceil((x1 - x0) / 8) * 8,
        h = Math.ceil((y1 - y0) / 8) * 8;
      const input = new Float32Array(3 * w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.min(x1 - 1, x0 + x),
            sy = Math.min(y1 - 1, y0 + y);
          for (let c = 0; c < 3; c++)
            input[c * w * h + y * w + x] = image.data[(sy * width + sx) * 4 + c] / 255;
        }
      const result = await model.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, h, w]) });
      const r = Object.values(result)[0].data as Float32Array;
      const W = w * 2;
      for (let y = ty; y < Math.min(height, ty + TILE); y++)
        for (let x = tx; x < Math.min(width, tx + TILE); x++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const ox = x * 2 + dx,
                oy = y * 2 + dy;
              const ix = (x - x0) * 2 + dx,
                iy = (y - y0) * 2 + dy;
              for (let c = 0; c < 3; c++)
                out[c * width * 2 * height * 2 + oy * width * 2 + ox] = r[c * (h * 2) * W + iy * W + ix];
            }
    }
  const canvas = new OffscreenCanvas(width * 2, height * 2);
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(width * 2, height * 2);
  const plane = width * 2 * height * 2;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++)
      data.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(out[c * plane + i] * 255)));
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const png = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
  return { png, ms: Math.round(performance.now() - started), provider };
}
