// The trial's photo list (docs/catalog-match-trials-20261102.md): the user's fifteen (checked against
// their manifest's SHA-256 and copied into the git-ignored results) and the public corpus's
// development photos, each with the faces and product boxes the earlier saved runs found. The twelve
// held-out photos are listed by id only: their data is read in round 7, after the combination is
// chosen (`--heldout`). Nothing here sends a photo anywhere.
//
//   node tests/catalog-match/photos.mjs [--heldout]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CORPUS_INPUTS, CORPUS_RUN, FIFTEEN_RUN, FIFTEEN_START, INPUTS, OUT, ROOT } from './paths.mjs';

const HELDOUT = process.argv.includes('--heldout');
const PHOTOS = join(OUT, 'photos');
mkdirSync(join(PHOTOS, 'fifteen'), { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Image-order corners: the one nearest the top-left first, then clockwise (as the photo shows it). */
export function imageOrder(quad) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4,
    cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...quad].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const first = sorted.reduce((best, p, i) => (p.x + p.y < sorted[best].x + sorted[best].y ? i : best), 0);
  return [...sorted.slice(first), ...sorted.slice(0, first)].map(({ x, y }) => ({ x, y }));
}
const planeOf = (plane) => ({
  face: plane.face,
  quad: imageOrder(plane.quad),
  tile: plane.tile ?? null,
});
const box = (b) => (Array.isArray(b) ? { left: b[0], top: b[1], right: b[2], bottom: b[3] } : b);

const photos = [];
// ---------- the user's fifteen ----------
const manifest = read(join(INPUTS, 'reconstruction-quality-next/fifteen-photo-manifest.json'));
const rooms = new Map(
  read(join(FIFTEEN_START, 'room-estimates-20260915.json')).cases.map((c) => [c.id, c.room]),
);
for (const file of manifest.files) {
  const target = join(PHOTOS, 'fifteen', `${file.id}.jpg`);
  // Read once and keep the bytes: a file just written can be locked for a moment (a virus scan).
  let bytes;
  if (existsSync(target)) bytes = readFileSync(target);
  else {
    bytes = readFileSync(file.path);
    if (sha(bytes) !== file.sha256) throw new Error(`${file.id}: the original no longer matches its SHA-256`);
    writeFileSync(target, bytes);
  }
  const meta = await sharp(bytes).metadata();
  const report = read(join(FIFTEEN_RUN, file.id, 'report-dom.json'));
  photos.push({
    id: file.id,
    split: 'fifteen',
    path: target,
    width: meta.width,
    height: meta.height,
    room: rooms.get(file.id),
    planes: report.review.planes.map(planeOf),
    candidates: report.review.candidates.map((c) => ({
      id: c.id,
      kind: c.kind,
      box: box(c.bounds),
      color: c.color ?? null,
      status: c.status ?? null,
      foot: c.foot ?? null,
      wall: c.installation?.wall ?? null,
      mode: c.installation?.mode ?? null,
      requested: c.placementReview?.requested ?? null,
      status: c.placementReview?.status ?? null,
      source: 'gemma-2026-09-16',
    })),
  });
}
// ---------- the public corpus ----------
const corpus = read(join(ROOT, 'tests/fixtures/reconstruction-corpus-v1.json'));
for (const c of corpus.cases) {
  if (c.split !== 'development' && !HELDOUT) {
    photos.push({ id: c.id, split: 'heldout', locked: true });
    continue;
  }
  const path = join(CORPUS_INPUTS, `${c.id}.jpg`);
  const meta = await sharp(readFileSync(path)).metadata();
  const baseline = read(join(CORPUS_RUN, c.id, 'baseline.json'));
  photos.push({
    id: c.id,
    split: c.split === 'development' ? 'corpus-dev' : 'heldout',
    path,
    width: meta.width,
    height: meta.height,
    room: { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
    planes: baseline.rawReview.planes.map(planeOf),
    candidates: baseline.rawReview.candidates.map((cand) => ({
      kind: cand.kind,
      box: box(cand.bounds),
      color: cand.color ?? null,
      status: cand.status ?? null,
      wall: cand.installation?.wall ?? null,
      mode: cand.installation?.mode ?? null,
      source: 'deeplab-2026-09-13',
    })),
    // The annotation is scoring only: never an AI input or a per-photo branch.
    truth: c.annotation.fixtures.map((f) => ({
      id: f.id,
      kind: f.kind,
      box: box(f.bounds),
      mounting: f.mounting,
      wall: f.installationWall,
      shape: f.shape,
      basinVariant: f.basinVariant,
      partial: f.partial,
      occluded: f.occluded,
    })),
    reflections: (c.annotation.reflections ?? []).map((r) => ({ ...r, box: box(r.bounds) })),
  });
}
writeFileSync(join(PHOTOS, 'index.json'), JSON.stringify({ heldoutOpened: HELDOUT, photos }, null, 1));
const count = (split) => photos.filter((p) => p.split === split).length;
console.log({ fifteen: count('fifteen'), corpusDev: count('corpus-dev'), heldout: count('heldout') });
