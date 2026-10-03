// Driver for variant comparisons of the per-product refinement (see worker.ts). Reads a job list
// (a JSON file: [{ id, inputs, name, reference, seed, extra?, scale? }]) and sends each job ONCE to the
// local temp Worker, never retrying, stopping at the first failure. Answers and prompts go to
// <out>/<id>.<ext> and <out>/<id>-prompt.txt; every call is recorded in <out>/calls.jsonl, and a job
// already recorded there is not sent again. The user approved further tests without a limit on
// 2026-10-03; the Worker's own cap still stops a runaway script.
// Usage (repository root, Worker running):  node tests/flux-product-refine/run-variants.mjs jobs.json <out> [--dry]
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const [, , jobsFile, out] = process.argv;
const dry = process.argv.includes('--dry');
if (!jobsFile || !out) throw new Error('Usage: run-variants.mjs jobs.json <out> [--dry]');
const worker = process.env.WORKER ?? 'http://127.0.0.1:8803';
const jobs = JSON.parse(await readFile(jobsFile, 'utf8'));
await mkdir(out, { recursive: true });
const ledger = `${out}/calls.jsonl`;
const done = (await readFile(ledger, 'utf8').catch(() => ''))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
let sent = 0;
for (const job of jobs) {
  if (done.some((entry) => entry.id === job.id && entry.status === 200)) continue;
  console.log('FLUX', job.id, dry ? '(dry)' : '');
  if (dry) continue;
  const meta = JSON.parse(await readFile(`${job.inputs}/${job.name}/meta.json`, 'utf8'));
  const form = new FormData();
  form.set(
    'image',
    new Blob([await readFile(`${job.inputs}/${job.name}/crop.png`)], { type: 'image/png' }),
    'crop.png',
  );
  if (job.reference)
    form.set(
      'reference',
      new Blob([await readFile(`${job.inputs}/${job.name}/reference.png`)], { type: 'image/png' }),
      'photo.png',
    );
  form.set('product', JSON.stringify(meta.product));
  form.set('seed', String(job.seed));
  if (job.extra) form.set('extra', job.extra);
  if (job.scale) form.set('scale', String(job.scale));
  const response = await fetch(worker, { method: 'POST', body: form });
  const body = await response.json();
  const entry = {
    id: job.id,
    status: body.status,
    ms: body.ms,
    width: body.width,
    height: body.height,
    promptLength: body.prompt?.length,
  };
  done.push(entry);
  sent++;
  await appendFile(ledger, JSON.stringify(entry) + '\n');
  await writeFile(`${out}/${job.id}-prompt.txt`, body.prompt ?? '');
  if (body.status !== 200) {
    await writeFile(`${out}/${job.id}-error.txt`, String(body.body ?? body.error));
    if (!process.argv.includes('--keep-going'))
      throw new Error(`FLUX ${job.id} failed (${body.status}); no retry.`);
    console.log('  FAILED', body.status, 'not retried; --keep-going');
    continue;
  }
  const bytes = Buffer.from((body.body.result ?? body.body).image, 'base64');
  const { format, width, height } = await sharp(bytes).metadata();
  await writeFile(`${out}/${job.id}.${format === 'jpeg' ? 'jpg' : format}`, bytes);
  console.log('  ok', body.ms, 'ms', `${width}×${height}`);
}
console.log(`sent ${sent} call(s)`);
