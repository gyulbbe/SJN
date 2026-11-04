/**
 * What each method sends (node): the app's current request rebuilt from the scene payload, and the
 * trial's variants, each changing one thing only. The prompts of the app come from the scene folder
 * (written by scenes.ts with the app's buildFluxPrompt); a variant edits that text in one place.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUX_CUTAWAY_SENTENCE } from '../../src/lib/ai-export/prompt';
import { FLUX_PROMPT } from '../../src/lib/ai-export/contract';
import { fluxNeurons } from './budget';

export const FLUX_4B = '@cf/black-forest-labs/flux-2-klein-4b';
export const SEEDS = [424242, 777001] as const;

/** ① A photograph's light and surface, added after the cutaway sentence; the keep-sentences stay. */
export const PHOTO_SENTENCE =
  'It must look like a real on-site photograph, not a 3D render: soft light from the ceiling with realistic indirect bounce, soft shadows in the corners and under each fixture, fine grout lines and subtle tile surface texture, glossy reflections on glazed ceramic, slight natural sensor noise.';
/** ③ The tile photos sent as images 1 and 2. */
export const REFERENCE_SENTENCE =
  'Image 1 is a photo of the wall tile and image 2 of the floor tile: use them only for the tiles’ colour, pattern and surface. Never take the camera, framing, room or fixtures from them; those stay exactly as in image 0.';

export type FluxMethod =
  'current' | 'photo' | 'short' | 'tileref' | 'large' | 'inroom' | 'empty' | 'placeholders';
export const METHOD_LABEL: Record<string, string> = {
  current: '지금 방식',
  photo: '① 사진 문장',
  short: '② 짧은 프롬프트',
  tileref: '③ 타일 참조',
  large: '④ 큰 입력(768)',
  inroom: '⑤ 방 안 눈높이',
  empty: '실험 A(빈 방)',
  placeholders: '실험 B(회색 자리)',
  refine: '실험 C(제품별 다듬기)',
  none: 'AI 없음(32장 + 사진 효과)',
};

/** Puts `sentence` right after the cutaway sentence (or after the fixed instruction without one). */
function insertAfterFrame(prompt: string, sentence: string): string {
  const anchor = prompt.includes(FLUX_CUTAWAY_SENTENCE) ? FLUX_CUTAWAY_SENTENCE : FLUX_PROMPT;
  const at = prompt.indexOf(anchor);
  if (at < 0) throw new Error('the prompt does not start with the app instruction');
  const end = at + anchor.length;
  return `${prompt.slice(0, end)} ${sentence}${prompt.slice(end)}`;
}
/** ② The keep instruction, the cutaway sentence and the fixture count only. */
export function shortPrompt(prompt: string): string {
  const summary = prompt.match(/Image 0 contains exactly[^.]*\.(?: Each one[^.]*\.)?/)?.[0];
  return [FLUX_PROMPT, prompt.includes(FLUX_CUTAWAY_SENTENCE) ? FLUX_CUTAWAY_SENTENCE : '', summary ?? '']
    .filter(Boolean)
    .join(' ');
}

export type PngSize = { width: number; height: number };
export const pngSize = (bytes: Buffer): PngSize => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

export type FluxRequest = {
  method: FluxMethod;
  images: Buffer[];
  prompt: string;
  width: number;
  height: number;
  estimate: number;
};
/** The FLUX request of one method for a scene folder; the output is twice the input, as the app asks. */
export function fluxRequest(method: FluxMethod, dir: string): FluxRequest {
  const read = (file: string) => readFileSync(join(dir, file));
  const text = (file: string) => readFileSync(join(dir, file), 'utf8');
  const current = text('prompt-current.txt');
  const pick = (): { images: Buffer[]; prompt: string } => {
    switch (method) {
      case 'current':
        return { images: [read('input.png')], prompt: current };
      case 'photo':
        return { images: [read('input.png')], prompt: insertAfterFrame(current, PHOTO_SENTENCE) };
      case 'short':
        return { images: [read('input.png')], prompt: shortPrompt(current) };
      case 'tileref':
        return {
          images: [read('input.png'), read('ref-wall.png'), read('ref-floor.png')],
          prompt: insertAfterFrame(current, REFERENCE_SENTENCE),
        };
      case 'large':
        return { images: [read('input-768.png')], prompt: current };
      case 'inroom':
        return { images: [read('inroom/input.png')], prompt: text('inroom/prompt-current.txt') };
      case 'empty':
        return { images: [read('input-empty.png')], prompt: text('prompt-empty.txt') };
      case 'placeholders':
        return { images: [read('input-placeholders.png')], prompt: text('prompt-placeholders.txt') };
    }
  };
  const { images, prompt } = pick();
  const size = pngSize(images[0]);
  const output = { width: size.width * 2, height: size.height * 2 };
  return {
    method,
    images,
    prompt,
    ...output,
    estimate: fluxNeurons(images.map(pngSize), output),
  };
}

/** The Stable Diffusion img2img prompt (77 tokens at most; the long FLUX prompt would be cut). */
export const SD_PROMPT =
  'photorealistic photograph of a modern bathroom interior, real ceramic tiles with grout lines, white ceramic toilet and washbasin, soft natural light, sharp detail';
export const SD_NEGATIVE = '3d render, cgi, cartoon, illustration, people, text, watermark, extra furniture';
