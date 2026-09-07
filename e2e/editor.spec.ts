import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { test, expect, type Page, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { DEFAULT_TILE, DEFAULT_COLOR, type ProjectDocument, type Quad } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });

const grayPhoto = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } })
    .png()
    .toBuffer();
const blueTile = () =>
  sharp({ create: { width: 200, height: 100, channels: 3, background: '#2277ee' } })
    .png()
    .toBuffer();
const redFixture = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="50" y="10" width="100" height="185" rx="20" fill="#ff2222"/></svg>',
    ),
  )
    .png()
    .toBuffer();
const wideRedFixture = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect x="40" y="20" width="320" height="170" rx="20" fill="#ff2222"/></svg>',
    ),
  )
    .png()
    .toBuffer();

async function createProject(page: Page, name = '검증 공간') {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await seedTestTiles(page);
  await page
    .getByTestId('project-upload')
    .setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: await grayPhoto() });
  await expect(page).toHaveURL(/\/projects\/[\w-]+/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
}
async function savedProject(page: Page): Promise<ProjectDocument> {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const id = page.url().split('/').at(-1)!;
  return page.evaluate(
    (id) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('projects').objectStore('projects').get(id);
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
      }),
    id,
  );
}
async function point(page: Page, x: number, y: number) {
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}
/** A previously saved photo project; no removed region-creation UI is invoked. */
async function makeSurface(page: Page) {
  const p = await savedProject(page);
  const q: Quad = [
    { x: 0.1, y: 0.35 },
    { x: 0.9, y: 0.35 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ];
  getActiveDesign(p)!.scene.surfaces = [
    {
      id: crypto.randomUUID(),
      name: '저장된 바닥',
      kind: 'floor',
      mask: { polygon: q, strokes: [] },
      quad: q,
      widthMm: 2400,
      heightMm: 1800,
      calibrated: false,
      tile: { ...DEFAULT_TILE },
      color: { ...DEFAULT_COLOR },
    },
  ];
  await page.evaluate(
    (project) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('gongganmiri-v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(project);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    p,
  );
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption(getActiveDesign(p)!.scene.surfaces[0].id);
}
async function setRange(locator: Locator, value: string) {
  await locator.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await locator.press('ArrowRight');
  await locator.press('ArrowLeft');
  await locator.blur();
}
async function pixels(page: Page, coordinates: { x: number; y: number }[]) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate((canvas, coordinates) => {
    const source = canvas as HTMLCanvasElement,
      c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(source, 0, 0);
    return coordinates.map((p) => [
      ...ctx.getImageData(Math.floor(p.x * c.width), Math.floor(p.y * c.height), 1, 1).data,
    ]);
  }, coordinates);
}
async function pauseViewMetadata(page: Page, assetId: string) {
  await page.evaluate((assetId) => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      if (this.name === 'assets' && key === assetId) {
        IDBObjectStore.prototype.get = original;
        request.addEventListener(
          'success',
          (event) => {
            event.stopImmediatePropagation();
            (window as unknown as { resumeViewMetadata: () => void }).resumeViewMetadata = () =>
              request.dispatchEvent(new Event('success'));
          },
          { once: true },
        );
      }
      return request;
    };
  }, assetId);
}
async function resumeViewMetadata(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { resumeViewMetadata?: () => void }).resumeViewMetadata,
      ),
    )
    .toBe('function');
  await page.evaluate(async () => {
    (window as unknown as { resumeViewMetadata: () => void }).resumeViewMetadata();
    delete (window as unknown as { resumeViewMetadata?: () => void }).resumeViewMetadata;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
async function registerMaterial(page: Page, category: 'tile' | 'basin') {
  const name = category === 'tile' ? '직접 등록한 블루 타일' : '직접 등록한 세면대';
  const buffer = category === 'tile' ? await blueTile() : await redFixture();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await dialog.getByLabel('상품명').fill(name);
  await dialog.getByLabel('카테고리', { exact: true }).selectOption(category);
  await dialog.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await dialog
    .getByLabel(category === 'tile' ? '세로 (mm)' : '높이 (mm)', { exact: true })
    .fill(category === 'tile' ? '300' : '600');
  await dialog
    .getByLabel('대표 이미지 올리기', { exact: true })
    .setInputFiles({ name: '상품.png', mimeType: 'image/png', buffer });
  await expect(dialog.getByLabel('대표 이미지 변경', { exact: true })).toBeEnabled();
  if (category === 'tile') {
    await dialog.getByLabel('기본 줄눈 폭 (mm)', { exact: true }).fill('0');
    await dialog
      .getByLabel('+ 타일 텍스처 올리기', { exact: true })
      .setInputFiles({ name: 'texture.png', mimeType: 'image/png', buffer });
    await expect(dialog.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  } else {
    await dialog.getByLabel('+ 제품 방향 이미지 올리기', { exact: true }).setInputFiles([
      { name: 'fixture.png', mimeType: 'image/png', buffer },
      { name: 'wide-side.png', mimeType: 'image/png', buffer: await wideRedFixture() },
    ]);
    await expect(
      dialog.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
    ).toHaveCount(2);
    await dialog.getByLabel('촬영 방향 2', { exact: true }).selectOption('왼쪽 측면');
    await dialog.getByLabel('기준점 X').nth(1).fill('25');
    await dialog.getByRole('spinbutton', { name: /^Y/ }).nth(1).fill('80');
  }
  await dialog.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  if (category === 'basin') await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name}.*600`) })).toBeVisible();
  return name;
}

test('기존 사진의 제품 방향·읽기 실패·지연 취소·배치·잠금·삭제·재진입', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await createProject(page, '제품 배치 검증');
  await makeSurface(page);
  await page.getByRole('button', { name: /라이트 스톤.*600/ }).click();
  const name = await registerMaterial(page, 'basin');
  await page.getByRole('button', { name: new RegExp(`${name}.*600`) }).click();
  await expect(page.getByRole('heading', { name: '제품 속성', exact: true })).toBeVisible();
  await page.getByLabel('기준점 가로 (%)', { exact: true }).fill('50');
  await page.getByLabel('기준점 세로 (%)', { exact: true }).fill('70');
  await setRange(page.getByLabel('그림자 진하기', { exact: true }), '0');
  const placed = await savedProject(page);
  expect(getActiveDesign(placed)!.scene.fixtures).toHaveLength(1);
  const fixture = getActiveDesign(placed)!.scene.fixtures[0];
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('1');
  await expect(page.getByLabel('제품 촬영 방향', { exact: true })).toHaveAttribute('aria-busy', 'false');
  const side = await savedProject(page);
  expect(getActiveDesign(side)!.scene.fixtures[0].viewIndex).toBe(1);
  expect(getActiveDesign(side)!.scene.fixtures[0].width).toBe(fixture.width);
  expect(getActiveDesign(side)!.scene.fixtures[0].height).toBeCloseTo(
    (((fixture.width * 800) / 600) * 200) / 400,
    8,
  );
  expect(getActiveDesign(side)!.scene.fixtures[0].position).toEqual(fixture.position);
  expect(getActiveDesign(side)!.scene.fixtures[0].anchor).toEqual({ x: 0.25, y: 0.8 });
  expect(getActiveDesign(side)!.history.past.length).toBe(getActiveDesign(placed)!.history.past.length + 1);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0]).toEqual(fixture);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0]).toEqual(
    getActiveDesign(side)!.scene.fixtures[0],
  );
  await page.getByRole('button', { name: '배치 잠금', exact: true }).click();
  await expect(page.getByLabel('제품 촬영 방향', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '잠금 해제', exact: true }).click();
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('0');
  await expect(page.getByLabel('제품 촬영 방향', { exact: true })).toHaveAttribute('aria-busy', 'false');
  const beforeMove = await savedProject(page);
  expect(getActiveDesign(beforeMove)!.scene.fixtures[0]).toEqual(fixture);
  const sideAssetId = await page.evaluate(
    (versionId) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('gongganmiri-v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('versions').objectStore('versions').get(versionId);
          request.onsuccess = () => {
            db.close();
            resolve(request.result.views[1].assetId);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        };
      }),
    fixture.materialVersionId,
  );
  await page.evaluate((assetId) => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'assets' && key === assetId) {
        IDBObjectStore.prototype.get = original;
        throw new Error('제품 이미지 읽기 테스트 오류');
      }
      return original.call(this, key);
    };
  }, sideAssetId);
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('1');
  await expect(page.getByRole('alert').filter({ hasText: '제품 이미지 읽기 테스트 오류' })).toBeVisible();
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0]).toEqual(fixture);
  await pauseViewMetadata(page, sideAssetId);
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('1');
  await expect(page.getByLabel('제품 촬영 방향', { exact: true })).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await resumeViewMetadata(page);
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0]).toEqual(fixture);
  await pauseViewMetadata(page, sideAssetId);
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('1');
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('0');
  await resumeViewMetadata(page);
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0]).toEqual(fixture);
  const testY = fixture.position.y - fixture.height * 0.5;
  await expect.poll(async () => (await pixels(page, [{ x: 0.5, y: testY }]))[0][0]).toBe(255);
  const start = await point(page, 0.5, testY),
    end = await point(page, 0.72, testY);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const moved = await savedProject(page);
  expect(getActiveDesign(moved)!.scene.fixtures[0].position.x).toBeCloseTo(0.72, 2);
  expect(getActiveDesign(moved)!.history.past.length).toBe(
    getActiveDesign(beforeMove)!.history.past.length + 1,
  );
  await expect.poll(async () => (await pixels(page, [{ x: 0.5, y: testY }]))[0][0]).toBeLessThan(240);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await savedProject(page);
  expect(getActiveDesign(undone)!.scene.fixtures[0].position).toEqual(fixture.position);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures[0].position).toEqual(
    getActiveDesign(moved)!.scene.fixtures[0].position,
  );
  const restored = await savedProject(page);
  await page.screenshot({ path: testInfo.outputPath('product-after-move.png'), fullPage: true });
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByText('이 탭은 읽기 전용입니다.', { exact: false })).toBeVisible();
  await expect(other.getByTestId('editor-canvas')).toBeVisible();
  await other.locator('[data-entity="' + fixture.id + '"]').click();
  await expect(other.getByRole('button', { name: '제품 삭제', exact: true })).toBeDisabled();
  expect(getActiveDesign(await savedProject(other))!.scene).toEqual(getActiveDesign(restored)!.scene);
  await other.close();
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(getActiveDesign(restored)!.scene);
  await page.locator('[data-entity="' + fixture.id + '"]').click();
  await pauseViewMetadata(page, sideAssetId);
  await page.getByLabel('제품 촬영 방향', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  await resumeViewMetadata(page);
  expect(getActiveDesign(await savedProject(page))!.scene.fixtures).toHaveLength(0);
});

test('이미지 확장자를 가장한 잘못된 파일을 거절한다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await page
    .getByTestId('project-upload')
    .setInputFiles({ name: '공간.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') });
  await expect(page.getByRole('alert').filter({ hasText: '올바른 JPG, PNG, WebP 이미지' })).toBeVisible();
  expect(page.url()).not.toContain('/projects/');
});

test('자동 저장 500ms 전 뒤로 이동해도 복귀하면 마지막 편집을 복원한다', async ({ page }) => {
  await createProject(page, '즉시 이동 검증');
  await makeSurface(page);
  await savedProject(page);
  const expectedName = '이동 직전 마지막 프로젝트 이름';
  await page.getByLabel('프로젝트명', { exact: true }).fill(expectedName);
  const pendingStatus = await page.getByTestId('save-status').textContent();
  expect(pendingStatus).toBe('변경사항 저장 대기');
  // No save-status wait here: navigate while the debounce is still pending.
  await page.goBack();
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  const returned = await savedProject(page);
  expect(returned.name).toBe(expectedName);
});
