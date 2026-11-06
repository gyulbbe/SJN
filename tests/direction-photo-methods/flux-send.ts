/**
 * One FLUX.2 klein call of a direction-photo trial: to local FLUX on this machine (free, shape screening
 * only, tests/direction-photo-real/local-flux/server.py on 127.0.0.1:8798) or to Cloudflare through the
 * trial's temporary Worker (billed, ai-worker/ on 127.0.0.1:8806). The answer is twice the guide's size.
 * No retry and no budget here: the caller checks its ledger before and writes it after.
 */
export type FluxPictures = { image0: Buffer; refs: Buffer[]; width: number; height: number };

export async function sendFlux(
  engine: 'local' | 'cf',
  p: FluxPictures,
  prompt: string,
  seed: number,
  model: string,
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
  const response = await fetch('http://127.0.0.1:8806/flux', { method: 'POST', body: form });
  const body = (await response.json()) as { image?: string; error?: string };
  return { status: response.status, image: body.image, error: body.error };
}
