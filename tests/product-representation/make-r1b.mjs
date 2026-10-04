// R1b: the R1 room with each product swapped for its twin that has only a 정면 photo (register-products.mjs
// --single), same places. A test tool that edits a copy of the stored project through the project API.
// Usage: node tests/product-representation/make-r1b.mjs <R1 project id>
import { d1 } from './lib.mjs';
const [sourceId] = process.argv.slice(2);
if (!sourceId) throw new Error('R1 project id needed');
const list = (await d1('materials', { operation: 'list' })).json;
const twin = new Map();
for (const row of list)
  if (row.version.name.startsWith('정면만 '))
    twin.set(row.version.name.replace('정면만 ', '평면 '), row.version);
if (twin.size !== 4) throw new Error('need the four 정면만 materials, found ' + twin.size);
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
for (const fixture of design.scene.fixtures) {
  const version = twin.get(fixture.name);
  if (!version) throw new Error('no twin for ' + fixture.name);
  fixture.materialVersionId = version.id;
  fixture.viewIndex = 0;
  fixture.anchor = { ...version.views[0].anchor };
  fixture.name = fixture.name.replace('평면 ', '정면만 ');
}
doc.name = 'R1b 정면 사진만';
const saved = await d1('projects', {
  operation: 'save',
  document: doc,
  expectedStorageRevision: doc.storageRevision,
});
if (saved.status !== 200) throw new Error('save ' + saved.status + ' ' + saved.text.slice(0, 600));
console.log('R1B_PROJECT_ID', doc.id);
