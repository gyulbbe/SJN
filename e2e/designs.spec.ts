import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';

test.use({ channel: 'chrome', actionTimeout: 15000 });
const manager = (page: Page) => page.getByRole('dialog', { name: /^시안 관리/ });
const card = (page: Page, name: string) =>
  manager(page)
    .getByTestId('design-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
async function openManager(page: Page) {
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  await expect(manager(page)).toBeVisible();
}
async function activate(page: Page, name: string) {
  await openManager(page);
  await card(page, name)
    .getByRole('button', { name: `${name} 편집하기`, exact: true })
    .click();
  await expect(manager(page)).toHaveCount(0);
  await expect(page.getByTestId('active-design-name')).toHaveText(name);
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
}
async function rename(page: Page, from: string, to: string) {
  await card(page, from)
    .getByRole('button', { name: `${from} 이름 변경`, exact: true })
    .click();
  await manager(page).getByLabel('새 시안 이름', { exact: true }).fill(to);
  await manager(page).getByRole('button', { name: '시안 이름 저장', exact: true }).click();
  await expect(card(page, to)).toHaveCount(1);
}
async function seedProduct(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 260;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#e74177';
    c.fillRect(30, 10, 120, 240);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    const now = new Date().toISOString(),
      assetId = crypto.randomUUID(),
      materialId = crypto.randomUUID(),
      versionId = crypto.randomUUID();
    const tx = db.transaction(['assets', 'versions', 'materials'], 'readwrite');
    tx.objectStore('assets').add({
      id: assetId,
      ownerId: 'local',
      name: '검증 제품.png',
      mime: 'image/png',
      size: blob.size,
      width: 180,
      height: 260,
      kind: 'product',
      createdAt: now,
      blob,
    });
    tx.objectStore('materials').add({
      id: materialId,
      ownerId: 'local',
      currentVersionId: versionId,
      active: true,
      scope: 'personal',
      updatedAt: now,
    });
    tx.objectStore('versions').add({
      id: versionId,
      materialId,
      version: 1,
      name: '검증 세면대',
      brand: '직접 제작',
      code: 'QA-DESIGNS-1',
      category: 'basin',
      scope: 'personal',
      description: '테스트용 직접 제작 이미지',
      color: '분홍',
      finish: '',
      widthMm: 500,
      heightMm: 750,
      depthMm: 450,
      usage: 'both',
      installation: 'floor',
      coverAssetId: assetId,
      imageAssetIds: [assetId],
      textureAssetIds: [],
      views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.98 } }],
      defaultGroutWidth: 2,
      defaultGroutColor: '#ddd',
      defaultPattern: 'grid',
      createdAt: now,
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
}
async function createRoom(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await seedTestTiles(page);
  await seedProduct(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 40000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await savedProject(page);
}
async function assets(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('gongganmiri-v1');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction('assets').objectStore('assets').getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return keys.sort();
  });
}
async function applyTile(page: Page, name: string) {
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: name }).click();
}
async function readyComparisons(page: Page, count: number) {
  await expect(page.getByTestId('comparison-card')).toHaveCount(count);
  await expect(page.getByTestId('comparison-card').getByRole('status')).toHaveCount(0, { timeout: 45000 });
  await expect(page.getByTestId('comparison-card').locator('img')).toHaveCount(count, { timeout: 45000 });
  await expect
    .poll(
      () =>
        page
          .getByTestId('comparison-card')
          .locator('img')
          .evaluateAll((images) =>
            images.every(
              (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      { timeout: 45000 },
    )
    .toBe(true);
}

async function comparisonPixels(page: Page, name: string) {
  return page
    .getByTestId('comparison-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .locator('img')
    .evaluate((image) => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      canvas.getContext('2d')!.drawImage(image as HTMLImageElement, 0, 0, 96, 64);
      return canvas.toDataURL();
    });
}

test('최신 시안 복사 → 타일·제품·자재 금액 독립 수정 → 동시 비교 → 재편집·다운로드·재진입', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const exceptions: string[] = [],
    uploads: string[] = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  page.on('request', (request) => {
    if (['POST', 'PUT'].includes(request.method()) && /api|supabase|r2|openai/i.test(request.url()))
      uploads.push(request.url());
  });
  await createRoom(page);
  await applyTile(page, '라이트 스톤');
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '검증 세면대' }).click();
  await savedProject(page);
  const price = page.getByLabel('라이트 스톤 단가 (원)', { exact: true });
  await price.fill('25000');
  await price.press('Enter');
  const source = await savedProject(page),
    a = getActiveDesign(source)!;
  const assetsBefore = await assets(page);
  await openManager(page);
  await card(page, '시안 A').getByRole('button', { name: '시안 A 복제', exact: true }).click();
  await rename(page, '시안 A 복사본', '시안 B');
  await card(page, '시안 B').getByRole('button', { name: '시안 B 편집하기', exact: true }).click();
  let project = await savedProject(page),
    b = getActiveDesign(project)!;
  expect(b.scene.fixtures[0].id).not.toBe(a.scene.fixtures[0].id);
  expect(b.scene.fixtures[0].position).toEqual(a.scene.fixtures[0].position);
  expect(b.materialUsage!.assignments[b.scene.surfaces[0].id].pricing.unitPrice).toBe(25000);
  expect(Object.keys(b.materialUsage!.assignments)).not.toEqual(Object.keys(a.materialUsage!.assignments));
  expect(b.history.past).toHaveLength(0);
  await applyTile(page, '차콜 스톤');
  const target = page.locator(`[data-testid="editor-canvas"] [data-entity="${b.scene.fixtures[0].id}"]`);
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 8, { steps: 5 });
  await page.mouse.up();
  project = await savedProject(page);
  b = getActiveDesign(project)!;
  expect(b.scene.fixtures[0].position).not.toEqual(a.scene.fixtures[0].position);
  expect(project.designs.find((d) => d.id === a.id)!.scene).toEqual(a.scene);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  project = await savedProject(page);
  expect(project.designs.find((d) => d.id === a.id)!.scene).toEqual(a.scene);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await savedProject(page);
  await openManager(page);
  await card(page, '시안 A').getByLabel('시안 A 비교 선택', { exact: true }).check();
  await card(page, '시안 B').getByLabel('시안 B 비교 선택', { exact: true }).check();
  await manager(page).getByRole('button', { name: '선택한 시안 비교' }).click();
  await readyComparisons(page, 2);
  const originalAPixels = await comparisonPixels(page, '시안 A'),
    originalBPixels = await comparisonPixels(page, '시안 B');
  await page.screenshot({ path: info.outputPath('two-designs.png'), fullPage: true });
  const comparisonCard = page
    .getByTestId('comparison-card')
    .filter({ has: page.getByRole('heading', { name: '시안 B', exact: true }) });
  await comparisonCard.getByRole('button', { name: '이 시안 편집', exact: true }).click();
  await expect(page.getByTestId('active-design-name')).toHaveText('시안 B');
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await applyTile(page, '클라우드 화이트');
  await savedProject(page);
  const refreshStarted = Date.now();
  await page.getByRole('button', { name: '시안 비교로 돌아가기', exact: true }).click();
  await readyComparisons(page, 2);
  await expect.poll(() => comparisonPixels(page, '시안 B')).not.toBe(originalBPixels);
  expect(await comparisonPixels(page, '시안 A')).toBe(originalAPixels);
  const refreshReport = { changedDesignReadyMs: Date.now() - refreshStarted };
  await writeFile(info.outputPath('changed-design-performance.json'), JSON.stringify(refreshReport, null, 2));
  await comparisonCard.getByRole('button', { name: '이 시안 편집', exact: true }).click();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  const previousAfter = await page
    .locator('[data-testid="canvas-frame"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('[data-testid="canvas-frame"] canvas')
        .evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
    )
    .not.toBe(previousAfter);
  const beforeImage = await page
    .locator('[data-testid="canvas-frame"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('[data-testid="canvas-frame"] canvas')
        .evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
    )
    .not.toBe(beforeImage);
  const expectedExport = await page
    .locator('[data-testid="canvas-frame"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toContain('시안 B');
  const exportBytes = await readFile((await download.path())!);
  const metadata = await sharp(exportBytes).metadata();
  expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(4096);
  const expectedPixels = await sharp(Buffer.from(expectedExport.split(',')[1], 'base64'))
    .resize(96, 64)
    .removeAlpha()
    .raw()
    .toBuffer();
  const outputPixels = await sharp(exportBytes).resize(96, 64).removeAlpha().raw().toBuffer();
  const exportError =
    outputPixels.reduce((sum, value, index) => sum + Math.abs(value - expectedPixels[index]), 0) /
    outputPixels.length;
  expect(exportError).toBeLessThan(7);
  expect(await assets(page)).toEqual(assetsBefore);
  await page.reload();
  project = await savedProject(page);
  expect(project.designs).toHaveLength(2);
  expect(project.comparisonDesignIds).toEqual([a.id, b.id]);
  await activate(page, '시안 A');
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(a.scene);
  expect(uploads).toEqual([]);
  expect(exceptions).toEqual([]);
});

test('생성 5개 제한·연속 클릭·5개 선택 한도·삭제 후 재생성·마지막 빈 상태', async ({ page }) => {
  test.setTimeout(180000);
  await createRoom(page);
  await openManager(page);
  await card(page, '시안 A')
    .getByRole('button', { name: '시안 A 복제', exact: true })
    .evaluate((button) => {
      for (let i = 0; i < 15; i++) (button as HTMLButtonElement).click();
    });
  await expect(manager(page).getByTestId('design-card')).toHaveCount(5);
  await expect(manager(page).getByRole('button', { name: '새 시안', exact: true })).toBeDisabled();
  await expect(manager(page)).toContainText('프로젝트당 시안은 최대 5개까지 만들 수 있습니다.');
  const checkboxes = manager(page).getByRole('checkbox');
  for (let i = 0; i < 5; i++) await checkboxes.nth(i).check();
  const selected = (await savedProject(page)).comparisonDesignIds;
  expect(selected).toHaveLength(5);
  await expect(checkboxes).toHaveCount(5);
  await expect(manager(page).getByRole('button', { name: '새 시안', exact: true })).toBeDisabled();
  expect((await storedProject(page)).comparisonDesignIds).toEqual(selected);
  await manager(page)
    .getByTestId('design-card')
    .first()
    .getByRole('button', { name: / 삭제$/ })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: '시안 삭제', exact: true }).click();
  await expect(manager(page).getByTestId('design-card')).toHaveCount(4);
  await manager(page).getByRole('button', { name: '새 시안', exact: true }).click();
  await expect(manager(page).getByTestId('design-card')).toHaveCount(5);
  for (let i = 5; i > 0; i--) {
    await manager(page)
      .getByTestId('design-card')
      .first()
      .getByRole('button', { name: / 삭제$/ })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: '시안 삭제', exact: true }).click();
    await expect(manager(page).getByTestId('design-card')).toHaveCount(i - 1);
  }
  await manager(page).getByRole('button', { name: '시안 관리 닫기' }).click();
  await expect(page.getByRole('heading', { name: '새 시안으로 시작하세요' })).toBeVisible();
  let p = await savedProject(page);
  expect(p.activeDesignId).toBeNull();
  expect(p.comparisonDesignIds).toEqual([]);
  await page.getByRole('button', { name: '새 시안 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  p = await savedProject(page);
  expect(p.designs).toHaveLength(1);
  expect(getActiveDesign(p)!.scene.fixtures).toHaveLength(0);
});

test('2·3·4·5개 비교 배치·동기 확대·독립 탐색·모바일·반복 개폐 성능', async ({ page }, info) => {
  test.setTimeout(240000);
  await createRoom(page);
  await applyTile(page, '클라우드 화이트');
  await savedProject(page);
  await openManager(page);
  for (let i = 0; i < 4; i++)
    await manager(page).getByRole('button', { name: '새 시안', exact: true }).click();
  const timings: { count: number; readyMs: number }[] = [];
  for (let count = 2; count <= 5; count++) {
    const boxes = manager(page).getByRole('checkbox');
    for (let i = 0; i < 5; i++) await boxes.nth(i).setChecked(i < count);
    const started = Date.now();
    await manager(page).getByRole('button', { name: '선택한 시안 비교' }).click();
    await readyComparisons(page, count);
    timings.push({ count, readyMs: Date.now() - started });
    const bounds = await page.getByTestId('comparison-viewport').evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    for (const b of bounds) expect(Math.abs(b.width - bounds[0].width)).toBeLessThan(2);
    const images = await page
      .getByTestId('comparison-card')
      .locator('img')
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }),
      );
    for (const image of images) expect(image.width / image.height).toBeCloseTo(4096 / 2731, 1);
    if (count === 4) expect(bounds[2].y).toBeGreaterThan(bounds[0].y);
    if (count === 5) expect(bounds[3].y).toBeGreaterThan(bounds[0].y);
    await page.screenshot({ path: info.outputPath(`compare-${count}.png`), fullPage: true });
    if (count < 5) {
      await page.getByRole('button', { name: '비교할 시안 선택', exact: true }).click();
    }
  }
  const view = page.getByTestId('comparison-viewport').first();
  await view.hover();
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() =>
      page
        .getByTestId('comparison-viewport')
        .evaluateAll((nodes) => new Set(nodes.map((n) => n.getAttribute('data-zoom'))).size),
    )
    .toBe(1);
  await expect.poll(() => view.getAttribute('data-zoom')).not.toBe('1');
  const before = (await savedProject(page)).editRevision;
  await page.getByLabel('확대·이동 동기화', { exact: true }).uncheck();
  await view.hover();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() =>
      page
        .getByTestId('comparison-viewport')
        .evaluateAll((nodes) => new Set(nodes.map((n) => n.getAttribute('data-zoom'))).size),
    )
    .toBeGreaterThan(1);
  await page.getByRole('button', { name: '모두 화면 맞춤', exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByTestId('comparison-viewport')
        .evaluateAll((nodes) => nodes.every((n) => n.getAttribute('data-zoom') === '1')),
    )
    .toBe(true);
  expect((await savedProject(page)).editRevision).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await readyComparisons(page, 5);
  await page.screenshot({ path: info.outputPath('compare-mobile.png'), fullPage: true });
  expect(await page.getByTestId('comparison-card').count()).toBe(5);
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('comparison-card').nth(i).scrollIntoViewIfNeeded();
    await expect(page.getByTestId('comparison-card').nth(i)).toBeInViewport();
  }
  await page
    .getByTestId('comparison-card')
    .last()
    .screenshot({ path: info.outputPath('mobile-last-card.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '편집으로 돌아가기', exact: true }).click();
    await page.getByRole('button', { name: '시안 비교로 돌아가기', exact: true }).click();
    await readyComparisons(page, 5);
  }
  await page.getByLabel('확대·이동 동기화', { exact: true }).check();
  await view.focus();
  await view.press('+');
  await view.press('ArrowRight');
  await expect
    .poll(() =>
      page
        .getByTestId('comparison-viewport')
        .evaluateAll((nodes) => new Set(nodes.map((n) => n.getAttribute('data-center-x'))).size),
    )
    .toBe(1);
  await view.press('ArrowDown');
  await expect
    .poll(() =>
      page
        .getByTestId('comparison-viewport')
        .evaluateAll((nodes) => new Set(nodes.map((n) => n.getAttribute('data-center-y'))).size),
    )
    .toBe(1);
  const motion = await page.evaluate(async () => {
    const target = document.querySelector('[data-testid="comparison-viewport"]')!;
    const times: number[] = [];
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    for (let i = 0; i < 90; i++)
      await new Promise<void>((resolve) =>
        requestAnimationFrame((t) => {
          times.push(t);
          target.dispatchEvent(
            new KeyboardEvent('keydown', { key: i % 2 ? 'ArrowLeft' : 'ArrowRight', bubbles: true }),
          );
          resolve();
        }),
      );
    observer.disconnect();
    const intervals = times
      .slice(1)
      .map((t, i) => t - times[i])
      .sort((a, b) => a - b);
    return {
      fps: (1000 * (times.length - 1)) / (times.at(-1)! - times[0]),
      frameP95Ms: intervals[Math.floor(intervals.length * 0.95)],
      longTasks,
    };
  });
  const report = {
    browser: await page.evaluate(() => navigator.userAgent),
    viewport: '1920x1080 / Chrome',
    gpu: await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'unavailable';
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = extension
        ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return renderer;
    }),
    timings,
    motion,
  };
  await writeFile(info.outputPath('comparison-performance.json'), JSON.stringify(report, null, 2));
  await info.attach('comparison-performance', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  const designsBeforeExclude = (await savedProject(page)).designs.map((d) => d.id);
  for (let count = 5; count > 1; count--) {
    await page
      .getByTestId('comparison-card')
      .first()
      .getByRole('button', { name: /비교에서 제외$/ })
      .click();
    await expect(page.getByTestId('comparison-card')).toHaveCount(count - 1);
  }
  expect((await savedProject(page)).designs.map((d) => d.id)).toEqual(designsBeforeExclude);
  await expect(
    page.getByText('시안을 2개 이상 선택하면 나란히 비교할 수 있어요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '비교할 시안 선택', exact: true }).click();
  await expect(manager(page).getByTestId('design-card')).toHaveCount(5);
  await page.screenshot({ path: info.outputPath('design-manager.png'), fullPage: true });
});
