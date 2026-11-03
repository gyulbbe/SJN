// The browser models of the catalog-match trial, at fixed Hugging Face revisions, into
// tmp/catalog-match/models/ (git-ignored). A file already there with the recorded size is kept; every
// file's SHA-256 goes to models.json. Model weights are only downloaded: no photo goes anywhere.
//
//   node tests/catalog-match/models.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODELS } from './paths.mjs';

/** Repository, revision, files; the licence is the original model's (read from its page). */
export const MODEL_FILES = [
  {
    key: 'dinov2-small',
    repo: 'onnx-community/dinov2-small',
    revision: '8b1f705a3a7f6f062f6bdd21986c1583d3ef105d',
    // int8 runs on the CPU even under WebGPU (325 ms vs fp16's 13 ms an image, 2026-11-02): the GPU
    // path uses fp16 / q4f16, the WASM path int8.
    files: [
      'onnx/model_quantized.onnx',
      'onnx/model_fp16.onnx',
      'onnx/model_q4f16.onnx',
      'preprocessor_config.json',
    ],
    original: 'facebook/dinov2-small',
  },
  // The size comparison (2026-11-03): the int8 file only, the one a deployment would use (WASM).
  {
    key: 'dinov2-base',
    repo: 'onnx-community/dinov2-base',
    revision: '31ef06cac16d5d301c5930d147002a058c85a5e4',
    files: ['onnx/model_quantized.onnx', 'preprocessor_config.json'],
    original: 'facebook/dinov2-base',
  },
  {
    key: 'dinov2-large',
    repo: 'onnx-community/dinov2-large',
    revision: '4b3550c593d51ac1a870d48d411f35eff4eaf353',
    files: ['onnx/model_quantized.onnx', 'preprocessor_config.json'],
    original: 'facebook/dinov2-large',
  },
  {
    key: 'clip-b32',
    repo: 'Xenova/clip-vit-base-patch32',
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    files: ['onnx/vision_model_quantized.onnx', 'onnx/vision_model_q4f16.onnx', 'preprocessor_config.json'],
    original: 'openai/clip-vit-base-patch32',
  },
  {
    key: 'siglip2-b16',
    repo: 'onnx-community/siglip2-base-patch16-224-ONNX',
    revision: 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4',
    files: ['onnx/vision_model_quantized.onnx', 'onnx/vision_model_q4f16.onnx', 'preprocessor_config.json'],
    original: 'google/siglip2-base-patch16-224',
  },
  {
    key: 'slimsam',
    repo: 'Xenova/slimsam-77-uniform',
    revision: '5850ab45f587c112167512ffef949107115e26a0',
    files: [
      'onnx/vision_encoder_quantized.onnx',
      'onnx/prompt_encoder_mask_decoder_quantized.onnx',
      'preprocessor_config.json',
    ],
    original: 'nielsr/slimsam-77-uniform',
  },
];

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
        downloadedAt: new Date().toISOString(),
        ms: Date.now() - started,
      };
      writeFileSync(join(MODELS, 'models.json'), JSON.stringify(record, null, 2));
      console.log('got', id, (bytes.length / 1e6).toFixed(1), 'MB');
    }
  }
}
