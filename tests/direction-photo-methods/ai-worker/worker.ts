/**
 * TEMPORARY local Worker for the direction-photo methods trial (docs/direction-photo-methods-results-20261105.md). It
 * is not part of the app. `wrangler dev` runs it on 127.0.0.1 with the `AI` binding of the account
 * wrangler is signed in to, so EVERY call it forwards is real and counts against that account's daily
 * neurons. The budget lives in tests/direction-photo-methods/budget.ts and run.ts (the ledger refuses before a call is sent);
 * CALL_CAP here only stops a runaway script. No call is retried.
 *
 *   npx wrangler dev --config tests/direction-photo-methods/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8806
 *
 * POST /flux  multipart: `model` and the model's own fields (input_image_N, prompt, width, height,
 *             seed), sent on as the app's callFlux sends them (multipart stream, raw response).
 * POST /run   JSON { model, input }: Clef and Gemma (JSON answers).
 */
const CALL_CAP = 400;
let calls = 0;

type Ai = { run: (model: string, input: unknown, options?: Record<string, unknown>) => Promise<unknown> };

const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

const worker = {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ calls, CALL_CAP });
    if (calls >= CALL_CAP) return Response.json({ ok: false, error: 'call cap reached' }, { status: 429 });
    calls++;
    const path = new URL(request.url).pathname;
    const started = Date.now();
    try {
      if (path === '/flux') {
        const form = await request.formData();
        const model = String(form.get('model'));
        if (
          !['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b'].includes(model)
        )
          return Response.json({ ok: false, error: 'only klein 4B or 9B in this trial' }, { status: 400 });
        const fields = new FormData();
        for (const [key, value] of form.entries()) if (key !== 'model') fields.append(key, value);
        const serialized = new Response(fields);
        const response = (await env.AI.run(
          model,
          { multipart: { body: serialized.body!, contentType: serialized.headers.get('content-type')! } },
          { returnRawResponse: true },
        )) as Response;
        const text = await response.text();
        if (!response.ok)
          return Response.json(
            { ok: false, ms: Date.now() - started, error: text.slice(0, 600) },
            { status: response.status },
          );
        const body = JSON.parse(text) as { result?: { image?: string }; image?: string };
        const image = (body.result ?? body).image;
        if (!image) return Response.json({ ok: false, error: 'no image in the answer' }, { status: 502 });
        return Response.json({ ok: true, ms: Date.now() - started, image });
      }
      const { model, input } = (await request.json()) as { model: string; input: unknown };
      let result = await env.AI.run(model, input);
      if (result instanceof Response) result = new Uint8Array(await result.arrayBuffer());
      else if (result instanceof ReadableStream)
        result = new Uint8Array(await new Response(result).arrayBuffer());
      if (result instanceof Uint8Array) {
        // An image model answers with the PNG itself; a text model may answer with JSON bytes.
        const png = result[0] === 0x89 && result[1] === 0x50;
        if (png) return Response.json({ ok: true, ms: Date.now() - started, image: toBase64(result) });
        const text = new TextDecoder().decode(result);
        try {
          result = JSON.parse(text);
        } catch {
          result = text;
        }
      }
      return Response.json({ ok: true, ms: Date.now() - started, result });
    } catch (error) {
      // Workers AI errors carry the Cloudflare code in the message ("3036: ...", "5006: ...").
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, ms: Date.now() - started, error: message }, { status: 502 });
    }
  },
};
export default worker;
