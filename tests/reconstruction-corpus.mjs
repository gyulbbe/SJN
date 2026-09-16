// Rehydrate or verify licensed evaluation inputs. Never runs an AI model.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const projectRoot = process.cwd();
const manifestPath = path.join(projectRoot, 'tests/fixtures/reconstruction-corpus-v1.json');
const checksumPath = path.join(projectRoot, 'tests/fixtures/reconstruction-corpus-v1.sha256');
const inputRoot = path.join(projectRoot, 'test-results/reconstruction-corpus/inputs');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? '--verify';
if (!['--verify', '--download'].includes(mode)) throw new Error('Use --verify or --download.');

const manifestBytes = await fs.readFile(manifestPath);
const expectedManifestHash = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
if (sha256(manifestBytes) !== expectedManifestHash) {
  throw new Error('Frozen manifest checksum mismatch. Do not silently rewrite the evaluation protocol.');
}
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const failures = [];
let verified = 0;

function localInputPath(entry) {
  const target = path.resolve(projectRoot, entry.input.path);
  if (path.dirname(target) !== inputRoot || path.basename(target) !== `${entry.id}.jpg`) {
    throw new Error(`Input path is outside the fixed corpus directory: ${entry.id}`);
  }
  return target;
}

function downloadUrl(entry) {
  const url = new URL(entry.source.downloadUrl);
  if (
    url.protocol !== 'https:' ||
    !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Only the frozen public Wikimedia image URL is allowed.');
  }
  return url;
}

async function publicPreview(entry) {
  const url = downloadUrl(entry);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'SJN-reconstruction-evaluation/1.0 (local licensed image evaluation)' },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    // Do not defeat rate limits by switching hosts or requesting alternate sizes.
    const retryAfter = response.headers.get('retry-after');
    throw new Error(`HTTP ${response.status}${retryAfter ? `; Retry-After ${retryAfter}` : ''}`);
  }
  const maximum = 25 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('Image exceeds 25 MiB.');
  if (!response.body) throw new Error('Response contains no image body.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error('Image exceeds 25 MiB.');
    chunks.push(chunk);
  }
  return sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}

for (const entry of manifest.cases) {
  try {
    const target = localInputPath(entry);
    let bytes;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT' || mode !== '--download') throw error;
      bytes = await publicPreview(entry);
      if (sha256(bytes) !== entry.input.sha256) {
        throw new Error('Downloaded/normalized bytes differ from freeze; remote source or Sharp changed.');
      }
      await fs.mkdir(inputRoot, { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
    }
    if (sha256(bytes) !== entry.input.sha256 || bytes.length !== entry.input.bytes) {
      throw new Error('Input checksum/size mismatch. Existing file was not overwritten.');
    }
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== entry.input.width || metadata.height !== entry.input.height) {
      throw new Error('Decoded dimensions mismatch.');
    }
    verified += 1;
    console.log(`${entry.id}: verified ${metadata.width}x${metadata.height} ${entry.source.license}`);
  } catch (error) {
    failures.push({ id: entry.id, message: String(error?.message ?? error) });
    console.error(`${entry.id}: ${String(error?.message ?? error)}`);
    if (/HTTP (429|503)/.test(String(error?.message ?? error))) break;
  }
}
console.log(
  JSON.stringify(
    {
      manifestSha256: expectedManifestHash,
      verified,
      total: manifest.cases.length,
      failures,
      normalizationRuntime: sharp.versions,
    },
    null,
    2,
  ),
);
if (verified !== manifest.cases.length) process.exitCode = 1;
