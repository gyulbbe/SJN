/**
 * TEMPORARY local Worker for the catalog-match trial (docs/catalog-match-trials-20261102.md). It is not
 * part of the app. `wrangler dev` runs it on 127.0.0.1 with the `AI` binding of the account wrangler is
 * signed in to, so EVERY call it forwards is real and counts against that account's daily neurons. The
 * budget lives in tests/catalog-match/ai.ts (the ledger refuses before a call is sent); CALL_CAP here
 * only stops a runaway script. No call is retried.
 *
 *   npx wrangler dev --config tests/catalog-match/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8799
 */
const CALL_CAP = 600;
let calls = 0;

type Ai = { run: (model: string, input: unknown) => Promise<unknown> };

const worker = {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ calls, CALL_CAP });
    if (calls >= CALL_CAP) return Response.json({ error: 'call cap reached' }, { status: 429 });
    calls++;
    const { model, input } = (await request.json()) as { model: string; input: unknown };
    const started = Date.now();
    try {
      let result = await env.AI.run(model, input);
      // Some models (Moondream) answer with a stream or a Response rather than an object.
      if (result instanceof Response) result = await result.text();
      else if (result instanceof ReadableStream) result = await new Response(result).text();
      if (typeof result === 'string')
        try {
          result = JSON.parse(result);
        } catch {
          /* plain text stays text */
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
