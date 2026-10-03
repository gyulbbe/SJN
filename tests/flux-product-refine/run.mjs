// Driver for the per-product refinement experiment (see worker.ts). Sends each job ONCE to the local
// temp Worker, records every call in real/calls.jsonl, never retries, stops at the first failure and
// at FLUX_CAP calls in total (the approved number). Nothing is sent without an explicit stage argument.
// Usage (from the repository root, with the Worker running):
//   node tests/flux-product-refine/run.mjs flux [--dry]
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = 'test-results/flux-product-refine';
const worker = process.env.WORKER ?? 'http://127.0.0.1:8803';
const dry = process.argv.includes('--dry');
const FLUX_CAP = 12;
const names = ['bear-toilet', 'smart-toilet', 'bathtub'];
const seeds = [424242, 777001];
const conditions = ['crop', 'crop-photo'];
if (process.argv[2] !== 'flux') throw new Error('Usage: run.mjs flux [--dry]');
await mkdir(`${root}/real`, { recursive: true });
const ledger = `${root}/real/calls.jsonl`;
const done = (await readFile(ledger, 'utf8').catch(() => ''))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
for (const seed of seeds)
  for (const condition of conditions)
    for (const name of names) {
      const job = `${name}-${condition}-${seed}`;
      if (done.some((entry) => entry.name === job)) continue;
      if (done.length >= FLUX_CAP) throw new Error(`FLUX cap (${FLUX_CAP}) reached; stopping.`);
      console.log('FLUX', job, dry ? '(dry)' : '');
      if (dry) continue;
      const meta = JSON.parse(await readFile(`${root}/inputs/${name}/meta.json`, 'utf8'));
      const form = new FormData();
      form.set(
        'image',
        new Blob([await readFile(`${root}/inputs/${name}/crop.png`)], { type: 'image/png' }),
        'crop.png',
      );
      if (condition === 'crop-photo')
        form.set(
          'reference',
          new Blob([await readFile(`${root}/inputs/${name}/reference.png`)], { type: 'image/png' }),
          'photo.png',
        );
      form.set('product', JSON.stringify(meta.product));
      form.set('seed', String(seed));
      const response = await fetch(worker, { method: 'POST', body: form });
      const body = await response.json();
      const entry = {
        name: job,
        status: body.status,
        ms: body.ms,
        width: body.width,
        height: body.height,
        promptLength: body.prompt?.length,
      };
      done.push(entry);
      await appendFile(ledger, JSON.stringify(entry) + '\n');
      await writeFile(`${root}/real/${job}-prompt.txt`, body.prompt ?? '');
      if (body.status !== 200) {
        await writeFile(`${root}/real/${job}-error.txt`, String(body.body ?? body.error));
        throw new Error(`FLUX ${job} failed (${body.status}); no retry.`);
      }
      const bytes = Buffer.from((body.body.result ?? body.body).image, 'base64');
      const { format, width, height } = await sharp(bytes).metadata();
      await writeFile(`${root}/real/${job}.${format === 'jpeg' ? 'jpg' : format}`, bytes);
      console.log('  ok', body.ms, 'ms', `${width}×${height}`);
    }
