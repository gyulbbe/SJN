/** Browser canvas/PNG/repository regression: node --experimental-strip-types tests/extract-fixture-browser.ts. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const directory = 'test-results/extract-fixture-qa';
await mkdir(directory, { recursive: true });
const bundle = await build({
  stdin: {
    contents:
      "export * from './src/lib/extract-fixture'; export {createLocalRepositories} from './src/lib/repositories/local';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'ExtractionTest',
  platform: 'browser',
});
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<title>Fixture extraction regression</title>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const lib = (
      window as unknown as {
        ExtractionTest: typeof import('../src/lib/extract-fixture') &
          typeof import('../src/lib/repositories/local');
      }
    ).ExtractionTest;
    const canvas = (width: number, height: number) => {
      const value = document.createElement('canvas');
      value.width = width;
      value.height = height;
      return value;
    };
    const source = canvas(8, 6),
      mask = canvas(8, 6);
    const ctx = source.getContext('2d')!,
      mc = mask.getContext('2d')!;
    const sourcePixels = ctx.createImageData(8, 6),
      maskPixels = mc.createImageData(8, 6);
    for (let i = 0; i < sourcePixels.data.length; i += 4) sourcePixels.data.set([37, 121, 203, 255], i);
    // At low alpha, a canvas round-trip would change the RGB significantly; PNG must not.
    for (let y = 2; y < 5; y++)
      for (let x = 2; x < 6; x++) maskPixels.data.set([0, 0, 0, [1, 128, 0, 255][x - 2]], (y * 8 + x) * 4);
    ctx.putImageData(sourcePixels, 0, 0);
    mc.putImageData(maskPixels, 0, 0);
    const extraction = await lib.extractFixture(source, mask);
    const decode = await createImageBitmap(extraction.blob);
    const decodedSize = [decode.width, decode.height];
    decode.close();
    const repositories = lib.createLocalRepositories(`extract-fixture-${crypto.randomUUID()}`);
    const originalId = crypto.randomUUID();
    const originalBlob = await new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!)));
    await repositories.assets.put({
      id: originalId,
      ownerId: 'local',
      name: 'original.png',
      mime: 'image/png',
      size: originalBlob.size,
      width: source.width,
      height: source.height,
      kind: 'original',
      createdAt: new Date().toISOString(),
      blob: originalBlob,
    });
    const first = await lib.registerExtractedFixture(
      source,
      mask,
      { name: '분리한 변기', category: 'toilet', sourceAssetId: originalId },
      repositories,
    );
    const firstVersion = await repositories.materials.getVersion(first.materialVersionId);
    const firstAsset = await repositories.assets.get(firstVersion.views[0].assetId);
    const second = await lib.registerExtractedFixture(
      source,
      mask,
      { name: '분리한 세면대', category: 'basin', widthMm: 520, heightMm: 740, depthMm: 400 },
      repositories,
    );
    const secondVersion = await repositories.materials.getVersion(second.materialVersionId);
    const empty = canvas(8, 6);
    const invalid: string[] = [];
    for (const test of [
      () => lib.registerExtractedFixture(source, empty, { name: 'empty', category: 'toilet' }, repositories),
      () =>
        lib.registerExtractedFixture(
          source,
          mask,
          { name: 'wrong category', category: 'tile' },
          repositories,
        ),
      () => lib.extractFixture(source, canvas(2, 2)),
    ]) {
      try {
        await test();
        invalid.push('unexpected success');
      } catch (error) {
        invalid.push(String(error));
      }
    }
    const assetsBefore = [...new Uint8Array(await originalBlob.arrayBuffer())];
    const originalAfter = [
      ...new Uint8Array(await (await repositories.assets.get(originalId)).blob.arrayBuffer()),
    ];
    const latestFirst = await repositories.materials.getVersion(first.materialVersionId);
    return {
      geometry: {
        bounds: extraction.bounds,
        position: extraction.position,
        width: extraction.width,
        height: extraction.height,
        anchor: extraction.anchor,
      },
      pngBytes: [...new Uint8Array(await extraction.blob.arrayBuffer())],
      decodedSize,
      first,
      firstVersion,
      second,
      secondVersion,
      originalUnchanged: JSON.stringify(assetsBefore) === JSON.stringify(originalAfter),
      inputPixelsUnchanged:
        [...ctx.getImageData(0, 0, 8, 6).data].every((value, index) => value === sourcePixels.data[index]) &&
        [...mc.getImageData(0, 0, 8, 6).data].every((value, index) => value === maskPixels.data[index]),
      firstVersionUnchanged: JSON.stringify(firstVersion) === JSON.stringify(latestFirst),
      asset: {
        mime: firstAsset.mime,
        kind: firstAsset.kind,
        sourceAssetId: firstAsset.sourceAssetId,
        width: firstAsset.width,
        height: firstAsset.height,
      },
      materialCount: (await repositories.materials.list()).length,
      projectCount: (await repositories.projects.list()).length,
      originalId,
      invalid,
    };
  });
  const png = Buffer.from(result.pngBytes);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(result.geometry, {
    bounds: { x: 2, y: 2, width: 4, height: 3 },
    position: { x: 0.5, y: 5 / 6 },
    width: 0.5,
    height: 0.5,
    anchor: { x: 0.5, y: 1 },
  });
  assert.deepEqual(result.decodedSize, [4, 3]);
  assert.equal(info.channels, 4);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 4; x++)
      assert.deepEqual(
        [...data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)],
        [37, 121, 203, [1, 128, 0, 255][x]],
      );
  assert.equal(result.firstVersion.scope, 'personal');
  assert.equal(result.firstVersion.version, 1);
  assert.equal(result.firstVersion.category, 'toilet');
  assert.ok(result.firstVersion.description.includes('추정값'));
  assert.equal(result.first.shadow.opacity, 0);
  assert.deepEqual(result.first.anchor, { x: 0.5, y: 1 });
  assert.equal(result.asset.sourceAssetId, result.originalId);
  assert.deepEqual(
    [result.secondVersion.widthMm, result.secondVersion.heightMm, result.secondVersion.depthMm],
    [520, 740, 400],
  );
  assert.notEqual(result.first.materialVersionId, result.second.materialVersionId);
  assert.equal(result.materialCount, 2);
  assert.equal(result.projectCount, 0);
  assert.ok(result.originalUnchanged && result.inputPixelsUnchanged && result.firstVersionUnchanged);
  assert.ok(result.invalid.every((error) => !error.includes('unexpected success')));
  assert.deepEqual(errors, []);
  const report = {
    browser: await browser.version(),
    ...result,
    pngBytes: undefined,
    exactDecodedRgba: [...data],
    pageErrors: errors,
  };
  await writeFile(`${directory}/transparent-fixture.png`, png);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    'EXTRACT_FIXTURE_PASS',
    JSON.stringify({ ...report, firstVersion: undefined, secondVersion: undefined }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
