// Backlog item 2 ("방이 덜 입체적": since 3037c8e the 3D room's walls are told apart by their corner
// shading only). How much the room's faces differ in light, in the 3D input and in the AI's finished
// pictures, before (6e0ca52) and after (3037c8e) the light change. No AI call: it reads the side-tile
// AI trial's pictures (tests/side-tile-ai, test-results/side-tile-ai-20261121/).
//
// Per picture, from the capture's region mask (mapped onto a result through the scene's layout.json,
// as composite.ts resultOnCapture maps the other way):
//   faces   mean L* of each wall and the floor, away from fixtures and other faces
//   corner  wall–wall: |ΔL*| of the bands 3–12 px either side of the corner line (local contrast)
//   floor   wall–floor: the same across the floor line
//   contact how much darker the floor is within 3–14 px of a fixture than the floor's mean (grounding)
//
// Usage: node tests/room-depth/depth-stats.mjs
// Output: test-results/room-depth-20261123/depth.json and a table on stdout
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const OUT = join(ROOT, 'test-results', 'room-depth-20261123');
mkdirSync(OUT, { recursive: true });
const CLOUD = join(ROOT, 'test-results', 'supervisor', 'cf1', 'test-results', 'side-tile-ai-20261121');

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lstar = (r, g, b) => {
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
};

/** The capture's labels on a picture's own pixel grid (the capture itself, or a 2× result). */
async function labelsFor(dir, width, height) {
  const m = await sharp(join(dir, 'mask.png')).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const cw = m.info.width,
    ch = m.info.height;
  if (width === cw && height === ch) return m.data;
  // The scene folders keep { layout, size }; the composite folders the layout alone.
  const saved = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8'));
  const layout = saved.layout ?? saved;
  const kx = layout.width / width,
    ky = layout.height / height;
  const out = new Uint8Array(width * height);
  for (let v = 0; v < height; v++) {
    const y = Math.floor((((v + 0.5) * ky - layout.y) * ch) / layout.contentHeight);
    for (let u = 0; u < width; u++) {
      const x = Math.floor((((u + 0.5) * kx - layout.x) * cw) / layout.contentWidth);
      out[v * width + u] = x < 0 || y < 0 || x >= cw || y >= ch ? 0 : m.data[y * cw + x];
    }
  }
  return out;
}
/** Box dilation of a 0/1 mask by r pixels (separable max). */
function dilate(mask, w, h, r) {
  const a = new Uint8Array(mask.length),
    b = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) last = x;
      else if (x - last <= r) a[y * w + x] = 1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) a[y * w + x] = 1;
    last = 1e9;
    for (let x = w - 1; x >= 0; x--)
      if (mask[y * w + x]) last = x;
      else if (last - x <= r) a[y * w + x] = 1;
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++)
      if (a[y * w + x]) last = y;
      else if (y - last <= r) b[y * w + x] = 1;
    for (let y = 0; y < h; y++) if (a[y * w + x]) b[y * w + x] = 1;
    last = 1e9;
    for (let y = h - 1; y >= 0; y--)
      if (a[y * w + x]) last = y;
      else if (last - y <= r) b[y * w + x] = 1;
  }
  return b;
}
async function depth(file, dir) {
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
  const img = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = img.info;
  const labels = await labelsFor(dir, w, h);
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = lstar(img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]);
  const ids = regions.map((_, i) => i + 1);
  const of = (id) => Uint8Array.from(labels, (v) => (v === id ? 1 : 0));
  const masks = Object.fromEntries(ids.map((id) => [id, of(id)]));
  const fixture = of(255);
  const near = (m, r) => dilate(m, w, h, r);
  const mean = (pick) => {
    let s = 0,
      n = 0;
    for (let i = 0; i < L.length; i++)
      if (pick(i)) {
        s += L[i];
        n++;
      }
    return n ? { L: s / n, n } : undefined;
  };
  const fixtureNear = near(fixture, 6);
  const faces = {};
  for (const id of ids) {
    const others = near(
      Uint8Array.from(labels, (v) => (v && v !== id && v !== 255 ? 1 : 0)),
      4,
    );
    const m = mean((i) => masks[id][i] && !others[i] && !fixtureNear[i]);
    if (m && m.n > 500) faces[id] = +m.L.toFixed(1);
  }
  const band = (a, b) => {
    const far = near(masks[b], 12),
      close = near(masks[b], 2);
    return mean((i) => masks[a][i] && far[i] && !close[i] && !fixtureNear[i]);
  };
  const corners = [],
    floors = [];
  for (const a of ids)
    for (const b of ids) {
      if (a >= b) continue;
      const ab = band(a, b),
        ba = band(b, a);
      if (!ab || !ba || ab.n < 200 || ba.n < 200) continue;
      const kinds = [regions[a - 1].kind, regions[b - 1].kind].sort().join('-');
      const d = +Math.abs(ab.L - ba.L).toFixed(1);
      if (kinds === 'wall-wall') corners.push(d);
      else if (kinds === 'floor-wall') floors.push(d);
    }
  const floorId = ids.find((id) => regions[id - 1].kind === 'floor');
  const ringOuter = near(fixture, 14),
    ringInner = near(fixture, 3);
  const ring = mean((i) => masks[floorId][i] && ringOuter[i] && !ringInner[i]);
  const avg = (a) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) : null);
  return {
    faces,
    corner: avg(corners),
    corners,
    floor: avg(floors),
    floors,
    contact: ring && faces[floorId] != null ? +(faces[floorId] - ring.L).toFixed(1) : null,
  };
}

const rows = [];
const add = async (row, file, dir) => {
  if (!existsSync(file)) return;
  const r = await depth(file, dir);
  rows.push({ ...row, ...r });
  console.log(
    `${row.set.padEnd(14)} ${row.id.padEnd(16)} ${row.rev.padEnd(6)} ${row.kind.padEnd(6)} corner ${String(r.corner).padStart(5)} floor ${String(r.floor).padStart(5)} contact ${String(r.contact).padStart(5)}  faces ${Object.values(r.faces).join(' ')}`,
  );
};
const scenes = ['olive-0', 'olive-90', 'black-0', 'beige-90', 'white-0'];
for (const rev of ['before', 'after']) {
  for (const s of scenes) {
    const dir = join(TRIAL, rev, 'scenes', s);
    await add({ set: 'input', id: s, rev, kind: 'input' }, join(dir, 'capture.png'), dir);
    for (const seed of [424242, 777001])
      await add(
        { set: 'local', id: `${s}-${seed}`, rev, kind: 'final' },
        join(TRIAL, rev, 'refined', `${s}-${seed}.png`),
        dir,
      );
  }
  for (const s of ['olive-0', 'olive-90', 'white-0']) {
    const dir = join(CLOUD, rev, 'scenes', s);
    await add(
      { set: 'cloud', id: `${s}-424242`, rev, kind: 'final' },
      join(CLOUD, rev, 'refined', `${s}-424242.png`),
      dir,
    );
    const cdir = join(TRIAL, rev, 'composite', s);
    await add({ set: 'composite-in', id: s, rev, kind: 'input' }, join(cdir, 'full.png'), cdir);
    await add(
      { set: 'composite', id: `${s}-424242`, rev, kind: 'final' },
      join(TRIAL, 'step05', `${rev}-${s}-local-fixed`, 'final.png'),
      cdir,
    );
  }
}
writeFileSync(join(OUT, 'depth.json'), JSON.stringify(rows, null, 1));
// Old against new, per set and kind: the means of corner, floor and contact.
const summary = {};
for (const r of rows) {
  const k = `${r.set}/${r.rev}`;
  const s = (summary[k] ??= { n: 0, corner: [], floor: [], contact: [] });
  s.n++;
  for (const key of ['corner', 'floor', 'contact']) if (r[key] != null) s[key].push(r[key]);
}
const avg = (a) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) : null);
console.log('\nmeans (set/rev: corner floor contact, n)');
for (const [k, s] of Object.entries(summary))
  console.log(`${k.padEnd(22)} ${avg(s.corner)} ${avg(s.floor)} ${avg(s.contact)}  n=${s.n}`);
writeFileSync(
  join(OUT, 'depth-summary.json'),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(summary).map(([k, s]) => [
        k,
        { n: s.n, corner: avg(s.corner), floor: avg(s.floor), contact: avg(s.contact) },
      ]),
    ),
    null,
    1,
  ),
);
