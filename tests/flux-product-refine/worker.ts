/**
 * TEMPORARY local Worker for the per-product refinement experiment (docs/flux-product-refine-results-*.md).
 * It is not part of the app. `wrangler dev` runs it on 127.0.0.1 with the production `AI` binding, so
 * EVERY call it forwards is real and billed (neurons). Run it only with the user's explicit approval
 * of the number of calls: FLUX_CAP below is that number, and no call is ever retried.
 *
 *   cd tests/flux-product-refine && npx wrangler dev --port 8803
 *   node tests/flux-product-refine/run.mjs flux [--dry]
 *
 * It sends exactly what the app's route will send: the crop as input_image_0, the real product's photo
 * as input_image_1 when there is one, the server-built prompt, a width and height twice the crop's.
 */
import { FLUX_MODEL } from '../../src/lib/ai-export/contract';
import { buildFluxProductPrompt, fluxProductSchema } from '../../src/lib/ai-export/product-prompt';

/** The approved number of FLUX calls for this session; raise it only after a new approval. */
const FLUX_CAP = 12;
let fluxCalls = 0;

type Ai = {
  run: (model: string, input: unknown, options: Record<string, unknown>) => Promise<Response>;
};

/** PNG IHDR width and height. */
function header(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const worker = {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ fluxCalls, FLUX_CAP });
    if (fluxCalls >= FLUX_CAP) return Response.json({ error: 'FLUX cap reached' }, { status: 429 });
    fluxCalls++;
    const form = await request.formData();
    const image = form.get('image') as File;
    const reference = form.get('reference') as File | null;
    const bytes = new Uint8Array(await image.arrayBuffer());
    const size = header(bytes);
    const product = fluxProductSchema.parse(JSON.parse(String(form.get('product'))));
    const prompt = buildFluxProductPrompt(product, !!reference);
    const input = new FormData();
    input.set('input_image_0', new Blob([bytes], { type: 'image/png' }), 'crop.png');
    if (reference)
      input.set(
        'input_image_1',
        new Blob([await reference.arrayBuffer()], { type: 'image/png' }),
        'photo.png',
      );
    input.set('prompt', prompt);
    input.set('width', String(size.width * 2));
    input.set('height', String(size.height * 2));
    input.set('seed', String(form.get('seed')));
    const serialized = new Response(input);
    const started = Date.now();
    const response = await env.AI.run(
      FLUX_MODEL,
      { multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! } },
      { returnRawResponse: true },
    );
    const text = await response.text();
    return Response.json({
      status: response.status,
      ms: Date.now() - started,
      prompt,
      width: size.width * 2,
      height: size.height * 2,
      body: response.ok ? JSON.parse(text) : text.slice(0, 2000),
    });
  },
};
export default worker;
