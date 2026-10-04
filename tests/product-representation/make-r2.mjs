// Makes the R2 study room from the saved R1 room: a copy of the project in which every photo product is
// a standard model (fixture.reconstruction) of the same size, place and a colour taken from its photo.
// The app has no such conversion; this is a test tool that edits the stored copy through the project API.
// Usage: node tests/product-representation/make-r2.mjs <R1 project id> [name]
import { readFileSync, writeFileSync } from 'node:fs';
import { d1, ROOT } from './lib.mjs';
const [sourceId, name = 'R2 표준 모형'] = process.argv.slice(2);
if (!sourceId) throw new Error('R1 project id needed');
const products = JSON.parse(readFileSync('tests/product-representation/products.json', 'utf8'));
const byName = Object.fromEntries(Object.values(products).map((p) => [p.name, p]));
// The standard model of each product: its kind, size (the material's width x height x depth), colour
// (products.json: the mean of the brighter half of the photo's opaque pixels) and the options that fit
// the photo: the bear toilet shows a seat ring without a lid (the seat-only model), the smart toilet a
// closed lid, the basin is wall-hung with a rounded bowl.
const OPTIONS = {
  '평면 곰 변기': { kind: 'toilet' },
  '평면 스마트 변기': { kind: 'toilet', toiletLidState: 'closed' },
  '평면 사각 욕조': { kind: 'bath' },
  '평면 벽걸이 세면대': { kind: 'basin', basinVariant: 'wall', basinShape: 'round', bowlCount: 1 },
};
const loaded = await d1('projects', { operation: 'load', id: sourceId });
if (loaded.status !== 200) throw new Error('load ' + loaded.status + ' ' + loaded.text.slice(0, 300));
const copyId = crypto.randomUUID();
const dup = await d1('projects', {
  operation: 'duplicate',
  id: sourceId,
  operationId: copyId,
  duplicateId: copyId,
});
if (dup.status !== 200) throw new Error('duplicate ' + dup.status + ' ' + dup.text.slice(0, 300));
const doc = dup.json;
const design = doc.designs.find((d) => d.id === doc.activeDesignId) ?? doc.designs[0];
const room = design.scene.room;
const log = [];
for (const fixture of design.scene.fixtures) {
  const p = byName[fixture.name];
  if (!p) throw new Error('unknown product ' + fixture.name);
  const o = OPTIONS[fixture.name];
  const placement = fixture.roomPlacement;
  const reconstruction = {
    version: 2,
    color: p.color,
    widthMm: p.width,
    heightMm: p.height,
    depthMm: p.depth,
    yawDegrees: 0,
    ...o,
  };
  if (o.kind === 'basin') {
    // The photo's content is centred on the reference point: the model's underside is half its height lower.
    const worldY = (1 - placement.v) * room.heightMm;
    reconstruction.baseHeightMm = Math.round(worldY - p.height / 2);
  } else reconstruction.baseHeightMm = 0;
  fixture.reconstruction = reconstruction;
  log.push({ name: fixture.name, face: placement.face, u: placement.u, v: placement.v, reconstruction });
}
doc.name = name;
const saved = await d1('projects', {
  operation: 'save',
  document: doc,
  expectedStorageRevision: doc.storageRevision,
});
if (saved.status !== 200) throw new Error('save ' + saved.status + ' ' + saved.text.slice(0, 600));
console.log(JSON.stringify(log, null, 1));
console.log('R2_PROJECT_ID', doc.id, 'status', saved.status);
writeFileSync(`${ROOT}/r2-fixtures.json`, JSON.stringify(log, null, 1));
