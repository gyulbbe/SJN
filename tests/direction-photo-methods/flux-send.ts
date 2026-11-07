/**
 * One FLUX.2 klein call of a direction-photo trial: to local FLUX on this machine (free, shape screening
 * only, tests/direction-photo-real/local-flux/server.py on 127.0.0.1:8798) or to Cloudflare through the
 * trial's temporary Worker (billed, ai-worker/ on 127.0.0.1:8806). The answer is twice the guide's size.
 * No retry and no budget here: the caller checks its ledger before and writes it after.
 *
 * With `rest`, a Cloudflare call goes straight to the Workers AI REST API of that account (the user's
 * second account, 2026-11-07: "cloudflare 계정 하나 더 있는데 그걸로 해봐"; its token can only run Workers
 * AI, so no Worker is uploaded there). The model's fields are the same multipart the Worker sends.
 */
export type FluxPictures = { image0: Buffer; refs: Buffer[]; width: number; height: number };
/** An account's REST access, read from a git-ignored file. Never printed or written to a ledger. */
export type RestAccount = { accountId: string; token: string };

/** CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from a KEY=value file; throws without printing them. */
export function parseAccountFile(text: string): RestAccount {
  const value = (key: string) =>
    text
      .match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? '';
  const accountId = value('CLOUDFLARE_ACCOUNT_ID'),
    token = value('CLOUDFLARE_API_TOKEN');
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID is not a 32-hex account id');
  if (!token || /\s/.test(token)) throw new Error('CLOUDFLARE_API_TOKEN is empty or has spaces');
  return { accountId, token };
}

export async function sendFlux(
  engine: 'local' | 'cf',
  p: FluxPictures,
  prompt: string,
  seed: number,
  model: string,
  rest?: RestAccount,
): Promise<{ status: number; image?: string; error?: string }> {
  const width = p.width * 2,
    height = p.height * 2;
  if (engine === 'local') {
    const response = await fetch('http://127.0.0.1:8798', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'flux-2-klein-4b',
        image: p.image0.toString('base64'),
        refs: p.refs.map((r) => r.toString('base64')),
        prompt,
        width,
        height,
        seed,
      }),
    });
    const body = (await response.json()) as { image?: string; error?: string; meta?: { engine?: string } };
    if (response.ok && body.meta?.engine !== 'local')
      throw new Error('the local server did not say it is local');
    return { status: response.status, image: body.image, error: body.error };
  }
  const form = new FormData();
  form.set('model', model);
  form.set('input_image_0', new Blob([new Uint8Array(p.image0)], { type: 'image/png' }), 'guide.png');
  p.refs.forEach((ref, i) =>
    form.set(
      `input_image_${i + 1}`,
      new Blob([new Uint8Array(ref)], { type: 'image/png' }),
      `photo-${i + 1}.png`,
    ),
  );
  form.set('prompt', prompt);
  form.set('width', String(width));
  form.set('height', String(height));
  form.set('seed', String(seed));
  if (rest) {
    form.delete('model');
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${rest.accountId}/ai/run/${model}`,
      { method: 'POST', headers: { Authorization: `Bearer ${rest.token}` }, body: form },
    );
    const text = await response.text();
    let body: { result?: { image?: string }; errors?: { code?: number; message?: string }[] } = {};
    try {
      body = JSON.parse(text);
    } catch {
      return { status: response.status, error: text.slice(0, 300) || 'no answer' };
    }
    const error = body.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ');
    return { status: response.status, image: body.result?.image, error: error || undefined };
  }
  const response = await fetch('http://127.0.0.1:8806/flux', { method: 'POST', body: form });
  const body = (await response.json()) as { image?: string; error?: string };
  return { status: response.status, image: body.image, error: body.error };
}
