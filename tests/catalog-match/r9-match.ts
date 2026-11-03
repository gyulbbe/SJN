/**
 * Round 9 (④ 점검에 따른 매칭, ⑤ 면마다 이유): today's pieces (② was not adopted), Gemma's check of
 * each (`r9-inspect.ts --pieces now`) and the fixed rule `decide()` give each face its tile:
 *   own    the fused first of round 1 (combination A)
 *   colour colour only, from the piece's lighter pixels, against the whole tile catalogue
 *   borrow the final tile of the photo's best-checked tile wall
 *   keep   the fused first, low confidence
 * and the sentence that says why. No AI call.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r9-match.ts
 * Output: test-results/catalog-match/r9-inspect/report.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadCatalog, out, readJson } from './data';
import { brightMask, decide, type Face, type FaceCheck, type Inspection } from './inspect';
import { colourDistance, colourFeatures, type Quad } from './tile-features';

const FUSED = 'clean.rect.raw|fused(classic+dinov2.patchmean.repeat)';
const target = join(out, 'r9-inspect');
type Piece = {
  id: string;
  photo: string;
  split: string;
  face: Face;
  regions: { clean?: { quad: Quad; mm: { widthMm: number; heightMm: number } } };
};
const pieces = readJson<Piece[]>(join(out, 'features', 'queries-photos-q8', 'faces.json'));
const photoTop = readJson<Record<string, Record<string, string[]>>>(
  join(out, 'r1-tiles-q8', 'photo-top12.json'),
);
const answers = readFileSync(join(target, 'answers-now.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { photo: string; faces: Face[]; result: unknown });
const checks = new Map<string, Inspection>();
for (const a of answers)
  try {
    const content = (a.result as { choices: { message: { content: string } }[] }).choices[0].message.content;
    for (const p of (JSON.parse(content) as { pieces: (Inspection & { number: number })[] }).pieces)
      if (a.faces[p.number - 1]) checks.set(`${a.photo}:${a.faces[p.number - 1]}`, p);
  } catch {
    /* no check for this photo: decide() keeps the fused first */
  }
const catalog = loadCatalog();
/** Colour only: the piece's lighter pixels against every tile allowed on this face. */
async function colourFirst(piece: Piece): Promise<string> {
  const { data, info } = await sharp(
    readFileSync(join(out, 'crops', 'photos', `${piece.id.replace(':', '-')}.jpg`)),
  )
    .resize(256, 256, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = { data, width: info.width, height: info.height };
  const colour = colourFeatures(image, brightMask(image));
  return catalog.tiles
    .filter((t) => (piece.face === 'floor' ? t.usage !== 'wall' : t.usage !== 'floor'))
    .map((t) => [t.id, colourDistance(colour, t.classic.colour)] as const)
    .sort((a, b) => a[1] - b[1])[0][0];
}

const faces: Record<string, unknown>[] = [];
for (const photo of [...new Set(pieces.map((p) => p.photo))]) {
  const own = pieces.filter((p) => p.photo === photo && photoTop[p.id]?.[FUSED]);
  const decisions = decide(
    own.map((p): FaceCheck => ({
      face: p.face,
      usable: !!p.regions.clean && p.regions.clean.mm.widthMm >= 300 && p.regions.clean.mm.heightMm >= 300,
      inspection: checks.get(p.id),
    })),
  );
  const pick = new Map<Face, string>();
  for (const [i, d] of decisions.entries())
    if (d.mode !== 'borrow')
      pick.set(d.face, d.mode === 'colour' ? await colourFirst(own[i]) : photoTop[own[i].id][FUSED][0]);
  for (const d of decisions) if (d.mode === 'borrow') pick.set(d.face, pick.get(d.from!)!);
  for (const [i, d] of decisions.entries())
    faces.push({
      id: own[i].id,
      photo,
      split: own[i].split,
      before: photoTop[own[i].id][FUSED][0],
      after: pick.get(d.face),
      checked: checks.has(own[i].id),
      ...d,
    });
}
const count = (key: string) =>
  faces.reduce<Record<string, number>>((t, f) => ((t[String(f[key])] = (t[String(f[key])] ?? 0) + 1), t), {});
writeFileSync(
  join(target, 'report.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), method: FUSED, faces }, null, 1),
);
console.log({
  faces: faces.length,
  checked: faces.filter((f) => f.checked).length,
  changed: faces.filter((f) => f.before !== f.after).length,
  modes: count('mode'),
  confidence: count('confidence'),
});
