/** Actual Chrome material workflow: node --experimental-strip-types tests/image-browser.ts */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import sharp from 'sharp';

const tile = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#cbbfae"/><path d="M0 80 Q180 220 350 100 T800 150 M0 310 Q220 150 480 350 T800 300" stroke="#a99b89" stroke-width="4" fill="none"/><rect x="35" y="25" width="730" height="450" stroke="#f2ebdd" stroke-width="12" fill="none"/></svg>')).png().toBuffer();
const fixture = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"><ellipse cx="300" cy="230" rx="180" ry="95" fill="#4d8a72"/><rect x="175" y="230" width="250" height="330" rx="25" fill="#75aa8b"/><ellipse cx="300" cy="230" rx="140" ry="60" fill="#c9ded0"/></svg>')).png().toBuffer();
const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#407e64' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
const bundle = await build({ stdin: { contents: "export {importImage} from './src/lib/images';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'ImageTest', platform: 'browser' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:3000/materials');
  await page.getByRole('heading', { name: '자재 라이브러리', exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const orientation = await page.evaluate(async bytes => {
    const { importImage } = (window as unknown as { ImageTest: typeof import('../src/lib/images') }).ImageTest;
    const input = new File([new Uint8Array(bytes)], 'oriented.jpg', { type: 'image/jpeg' });
    const saved: import('../src/lib/types').AssetRecord[] = [];
    const result = await importImage(input, 'original', { async put(asset) { saved.push(asset); }, async get() { throw new Error('unused'); }, async removeUnused() { return 0; } });
    const sameOriginal = new Uint8Array(await result.original.blob.arrayBuffer()).every((value, i) => value === bytes[i]);
    return { dimensions: [result.original.width, result.original.height, result.preview.width, result.preview.height], count: saved.length, sameOriginal, sourceLinked: result.preview.sourceAssetId === result.original.id };
  }, [...jpeg]);
  assert.deepEqual(orientation, { dimensions: [80, 120, 80, 120], count: 2, sameOriginal: true, sourceLinked: true });

  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  let form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel(/상품명/).fill('테스트 직사각 타일');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('세로 (mm)', { exact: true }).fill('300');
  await form.getByLabel('+ 타일 텍스처 올리기', { exact: true }).setInputFiles({ name: 'tile.png', mimeType: 'image/png', buffer: tile });
  await form.getByRole('button', { name: '한 장 선택·정면 보정', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '타일 한 장 선택·정면 보정', exact: true });
  await crop.getByRole('button', { name: '편집 결과 적용', exact: true }).click();
  await crop.waitFor({ state: 'detached' });
  await form.getByRole('button', { name: '대표 이미지로 사용', exact: true }).click();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '테스트 직사각 타일', exact: true }).waitFor();

  await page.getByRole('button', { name: '정보 수정', exact: true }).first().click();
  form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  await form.getByLabel('색상', { exact: true }).fill('웜 베이지');
  await form.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await form.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel(/상품명/).fill('테스트 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('450');
  await form.getByLabel('+ 제품 방향 이미지 올리기', { exact: true }).setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: fixture });
  assert.equal(await form.getByRole('button', { name: '배경 수동 지우기', exact: true }).count(), 0);
  assert.equal(await form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }).isEnabled(), true);
  await form.getByRole('button', { name: '대표 이미지로 사용', exact: true }).click();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  await page.reload();
  await page.getByRole('button', { name: '테스트 세면대', exact: true }).waitFor();
  const persisted = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('gongganmiri-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const read = <T,>(store: string) => new Promise<T[]>((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const versions = await read<import('../src/lib/types').MaterialVersion>('versions');
    const assets = await read<import('../src/lib/types').AssetRecord>('assets');
    const tileVersion = versions.filter(value => value.name === '테스트 직사각 타일').sort((a, b) => b.version - a.version)[0];
    const tileAsset = assets.find(value => value.id === tileVersion.textureAssetIds[0])!;
    const fixtureVersion = versions.find(value => value.name === '테스트 세면대')!;
    const fixtureAsset = assets.find(value => value.id === fixtureVersion.views[0].assetId)!;
    const original = assets.find(value => value.id === fixtureAsset.sourceAssetId)!;
    const alphaAt = async (blob: Blob) => { const bitmap = await createImageBitmap(blob); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); return ctx.getImageData(Math.floor(canvas.width * .1), Math.floor(canvas.height * .1), 1, 1).data[3]; };
    return { tileVersions: versions.filter(value => value.name === '테스트 직사각 타일').length, tileSize: [tileAsset.width, tileAsset.height], uploadedAlpha: await alphaAt(fixtureAsset.blob), originalAlpha: await alphaAt(original.blob) };
  });
  assert.deepEqual(persisted, { tileVersions: 2, tileSize: [1600, 800], uploadedAlpha: 0, originalAlpha: 0 });
  const secondTab = await context.newPage();
  await secondTab.goto('http://127.0.0.1:3000/materials');
  await secondTab.getByText('다른 탭에서 편집 중이에요.', { exact: false }).waitFor();
  assert.equal(await secondTab.getByRole('button', { name: '자재 등록', exact: true }).isDisabled(), true);
  await secondTab.close();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/material-library.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['EXIF 6 orientation and original bytes', 'tile upload and four-point correction', 'immutable material v2', 'transparent product PNG upload and AI test entry', 'original alpha preservation', 'refresh restoration', 'second-tab write lock'], persisted, screenshot: 'test-results/material-library.png' }, null, 2));
} finally { await browser.close(); }
