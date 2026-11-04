// The browser models this trial downloads (docs/export-photoreal-trials-20261104.md), each at a fixed
// revision, recorded with its size and SHA-256 in tmp/export-photoreal/models/models.json. The CLIP
// image side is the one catalog-match already downloaded (tmp/catalog-match/models/clip-b32); BiRefNet
// is the app's cached model (tmp/background-model). Nothing here is used by the app.
//
// Usage: node tests/export-photoreal/models.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODELS, ROOT } from './paths.mjs';

/** Repository, revision, files; the licence is the original model's (read from its page). */
export const MODEL_FILES = [
  {
    key: 'clip-b32',
    repo: 'Xenova/clip-vit-base-patch32',
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    files: ['onnx/text_model_quantized.onnx', 'tokenizer.json'],
    original: 'openai/clip-vit-base-patch32 (MIT)',
  },
  {
    key: 'swin2sr-x2',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    revision: '93dfc9089abda257351d3a58d5771e2c1ff69442',
    files: ['onnx/model.onnx', 'preprocessor_config.json'],
    original: 'caidas/swin2SR-classical-sr-x2-64 (Apache-2.0)',
  },
];
/** The CLIP image encoder from the catalog-match trial (same repository and revision). */
export const CLIP_VISION = join(
  ROOT,
  'tmp',
  'catalog-match',
  'models',
  'clip-b32',
  '6b7c523703ae',
  'onnx',
  'vision_model_quantized.onnx',
);

export const modelPath = (key, file) => {
  const model = MODEL_FILES.find((entry) => entry.key === key);
  return join(MODELS, key, model.revision.slice(0, 12), file);
};

if (process.argv[1]?.endsWith('models.mjs')) {
  const record = existsSync(join(MODELS, 'models.json'))
    ? JSON.parse(readFileSync(join(MODELS, 'models.json'), 'utf8'))
    : {};
  for (const model of MODEL_FILES) {
    for (const file of model.files) {
      const target = modelPath(model.key, file);
      const id = `${model.key}/${file}`;
      if (existsSync(target) && record[id]?.bytes === statSync(target).size) {
        console.log('kept', id);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
      const started = Date.now();
      const response = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(target, bytes);
      record[id] = {
        repo: model.repo,
        revision: model.revision,
        file,
        url,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        original: model.original,
        downloadedAt: new Date().toISOString(),
        ms: Date.now() - started,
      };
      writeFileSync(join(MODELS, 'models.json'), JSON.stringify(record, null, 1));
      console.log('got', id, `${(bytes.length / 1e6).toFixed(1)} MB`);
    }
  }
}
