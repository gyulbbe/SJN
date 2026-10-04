import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { getActiveDesign } from '../src/lib/designs';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

// A toilet that is a standard model (what a photo reconstruction places) in the room, then converted with
// "실험 C · 제품별 다듬기". The model is a mock (the crop painted blue and doubled in size) and so is the
// cut-out model (anything that is not plain white): no real AI runs, and nothing is downloaded. (A flat
// product photo is a photograph already and is not repainted; see refineTargets.)

/** A plain toilet-like shape on white: the material's flat photo. */
const toiletPhoto = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#fff"/><rect x="90" y="40" width="220" height="150" rx="24" fill="#e9e6df"/><rect x="70" y="190" width="260" height="360" rx="90" fill="#f2f1ec" stroke="#b9b5aa" stroke-width="6"/></svg>',
    ),
  )
    .png()
    .toBuffer();

async function installDoubles(page: Page) {
  await page.addInitScript(() => {
    const Original = Worker;
    class Double extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      private send(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data }));
      }
      postMessage(message: { id: number; blob?: Blob }) {
        // The cut-out model double: whatever is not plain white is the product.
        void (async () => {
          this.send({
            type: 'progress',
            id: message.id,
            progress: { stage: 'initializing', message: '검증용 윤곽 모델 준비' },
          });
          const bitmap = await createImageBitmap(message.blob!);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
          for (let i = 0; i < image.data.length; i += 4)
            if (image.data[i] > 250 && image.data[i + 1] > 250 && image.data[i + 2] > 250)
              image.data[i + 3] = 0;
          context.putImageData(image, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          this.send({
            type: 'result',
            id: message.id,
            result: {
              blob,
              width: bitmap.width,
              height: bitmap.height,
              analysisWidth: 512,
              analysisHeight: 512,
              backend: 'wasm',
              precision: 'fp32',
              downloadMs: 0,
              initializationMs: 0,
              processingMs: 1,
              inferenceMs: 1,
              cacheSource: 'memory',
            },
          });
        })();
      }
      terminate() {}
    }
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: function (url: string | URL, options?: WorkerOptions) {
        if (options?.name === 'sjn-background-removal') return new Double();
        return new Original(url, options);
      },
    });
  });
}

/**
 * Registers a toilet from the material form, places it in the default room, then makes the placed
 * product a standard model in the stored project (as a photo reconstruction would have made it) and
 * reopens the editor.
 */
async function placeStandardToilet(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('다듬을 변기');
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('400');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('750');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'toilet.png', mimeType: 'image/png', buffer: await toiletPhoto() });
  const photo = form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
  await expect(photo).toBeVisible();
  await expect
    .poll(() =>
      photo.evaluate(
        (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  await form.getByLabel('촬영 방향 1', { exact: true }).selectOption('정면');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '다듬을 변기' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  // The placed toilet becomes a standard model, in the stored project (the same place the editor reads).
  await expect.poll(async () => getActiveDesign(await app.project())!.scene.fixtures.length).toBe(1);
  const project = await app.project();
  const fixture = getActiveDesign(project)!.scene.fixtures[0];
  fixture.reconstruction = {
    version: 2,
    kind: 'toilet',
    color: '#f2f1ec',
    widthMm: 400,
    heightMm: 750,
    depthMm: 600,
  };
  const row = await app.env.DB.prepare('SELECT object_key FROM d1_projects WHERE id=?')
    .bind(project.id)
    .first<{ object_key: string }>();
  await app.env.ASSET_BUCKET.put(row!.object_key, JSON.stringify(project));
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
}

/** The crop painted blue, twice the size: what a mock model that repaints the product would send. */
async function blueProduct(crop: Buffer) {
  const { data, info } = await sharp(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const white = (i: number) => data[i * 3] >= 254 && data[i * 3 + 1] >= 254 && data[i * 3 + 2] >= 254;
  // The background is the white connected to the border; a white highlight inside stays product.
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (x < 0 || y < 0 || x >= width || y >= height || background[i] || !white(i)) return;
    background[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % width,
      y = Math.floor(i / width);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  const out = Buffer.alloc(width * height * 3, 255);
  for (let i = 0; i < width * height; i++) if (!background[i]) out.set([60, 120, 200], i * 3);
  return sharp(out, { raw: { width, height, channels: 3 } })
    .resize(width * 2, height * 2, { kernel: 'nearest' })
    .png()
    .toBuffer();
}
const pixels = (locator: Locator) =>
  locator.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: [...context.getImageData(0, 0, canvas.width, canvas.height).data],
    };
  });
async function formOf(request: import('@playwright/test').Request) {
  return new Response(new Uint8Array(request.postDataBuffer()!), {
    headers: { 'content-type': request.headers()['content-type'] },
  }).formData();
}

test('실험 C · 제품별 다듬기: 방은 빈 채로 한 번, 제품은 하나씩 한 번씩, 진행 표시와 되돌린 제품 알림', async ({
  page,
}, testInfo) => {
  await installDoubles(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const rooms: { scene: { fixtures: unknown[]; mode?: string } }[] = [];
  const products: { fields: string[]; seed: string; product: Record<string, unknown>; reference: boolean }[] =
    [];
  const checks: unknown[] = [];
  let productStatus = 200;
  await page.route('**/api/export/photoreal', async (route) => {
    const form = await formOf(route.request());
    rooms.push({ scene: JSON.parse(String(form.get('scene'))) });
    const input = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    const { width, height } = await sharp(input).metadata();
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: await sharp(input)
        .resize(width! * 2, height! * 2)
        .png()
        .toBuffer(),
    });
  });
  await page.route('**/api/export/photoreal/check', async (route) => {
    checks.push(1);
    await route.fulfill({ json: { fixtures: [], extras: [] } });
  });
  await page.route('**/api/export/photoreal/product', async (route) => {
    const form = await formOf(route.request());
    products.push({
      fields: [...form.keys()].sort(),
      seed: String(form.get('seed')),
      product: JSON.parse(String(form.get('product'))),
      reference: form.has('reference'),
    });
    // Slow enough to see the progress.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (productStatus !== 200)
      return route.fulfill({
        status: productStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Cloudflare AI 사용 한도를 모두 사용했어요.' }),
      });
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: await blueProduct(Buffer.from(await (form.get('image') as Blob).arrayBuffer())),
    });
  });
  await placeStandardToilet(page);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const methods = dialog.getByRole('group', { name: '변환 방식' });
  await expect(methods.getByRole('radio')).toHaveCount(4);
  // The room has a product C can repaint, so C is the method the dialog opens with (nothing chosen yet).
  await expect(methods.getByRole('radio', { name: '실험 C · 제품별 다듬기', exact: true })).toBeChecked();
  // What one click costs is said before the click: one product, so a request for it and one for the room.
  const note = dialog.getByTestId('flux-composite-note');
  await expect(note).toContainText('다듬을 제품은 1개');
  await expect(note).toContainText('AI 요청이 2회(제품 1 + 빈 방 1)');
  await expect(note).toContainText('최대 약 225뉴런(추정)');
  await expect(note).toContainText('지금 방식은 1회');
  await expect(note).toContainText('옆·뒤 면은 AI의 추측');
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  const source = dialog.getByAltText('AI 변환 기준 원본');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  // Progress: the products done of all, and a way to stop.
  const progress = dialog.getByTestId('flux-refine-progress');
  await expect(progress).toContainText('제품 다듬기 0/1개', { timeout: 60000 });
  await expect(progress.getByTestId('flux-refine-cancel')).toBeVisible();
  const refined = dialog.getByTestId('flux-refine-note');
  await expect(refined).toContainText('AI가 제품을 하나씩 따로 다듬어 제자리에 올렸어요', { timeout: 60000 });
  await expect(result).toBeVisible();
  await expect(progress).toHaveCount(0);
  // The room went out empty once; the product went out once, with the seed and its facts.
  expect(rooms).toHaveLength(1);
  expect(rooms[0].scene.fixtures).toEqual([]);
  expect(rooms[0].scene.mode).toBe('empty-room');
  expect(products).toHaveLength(1);
  // A standard model has no photo to send along: the crop, the facts and the seed only.
  expect(products[0].fields).toEqual(['image', 'product', 'seed']);
  expect(products[0].reference).toBe(false);
  expect(products[0].product).toMatchObject({ kind: 'toilet', finish: 'glossy' });
  expect(Object.keys(products[0].product).sort()).toEqual(['color', 'finish', 'forms', 'kind', 'sizeMm']);
  expect(products[0].product.color).toMatch(/^#[0-9a-f]{6}$/);
  await expect.poll(() => checks.length).toBe(1);
  // The product on screen is the model's (blue) where the render's product stands.
  const [shown, reference] = await Promise.all([pixels(result), pixels(source)]);
  expect([shown.width, shown.height]).toEqual([reference.width, reference.height]);
  let product = 0,
    blue = 0;
  for (let i = 0; i < reference.data.length; i += 4) {
    // The render's product is the only warm-or-grey thing that is not the grey room around it:
    // count the pixels that differ from the empty room as the model's blue.
    if (shown.data[i + 2] > shown.data[i] + 40) blue++;
    if (reference.data[i] !== shown.data[i] || reference.data[i + 2] !== shown.data[i + 2]) product++;
  }
  expect(blue).toBeGreaterThan(400);
  expect(product).toBeGreaterThan(blue * 0.5);
  await page.screenshot({ path: testInfo.outputPath('flux-refine.png') });
  // A limit spent on the product's request: that product stays the 3D render, said in plain words,
  // and the result is the render's again (no blue); the room was asked once more, the product once.
  productStatus = 429;
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b 다시 만들기', exact: true }).click();
  await expect(refined).toContainText('3D 렌더 그대로 둔 제품', { timeout: 60000 });
  await expect(refined).toContainText('Cloudflare AI 사용 한도를 모두 사용했어요.');
  expect(products).toHaveLength(2);
  expect(rooms).toHaveLength(2);
  expect(products[1].seed).not.toBe(products[0].seed);
  // The picture follows the note a moment later: wait for it to lose the model's blue.
  await expect
    .poll(
      async () => {
        const kept = await pixels(result);
        let count = 0;
        for (let i = 0; i < kept.data.length; i += 4) if (kept.data[i + 2] > kept.data[i] + 40) count++;
        return count;
      },
      { timeout: 30000 },
    )
    .toBeLessThan(blue / 10);
  // 390px: nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // Choosing the current method is remembered too (it is no longer "nothing chosen"): the dialog opens
  // with it next time, and with C again once C is chosen.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await methods.getByText('지금 방식', { exact: true }).click();
  await expect(methods.getByRole('radio', { name: '지금 방식', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(methods.getByRole('radio', { name: '지금 방식', exact: true })).toBeChecked();
  await methods.getByText('실험 C · 제품별 다듬기', { exact: true }).click();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(methods.getByRole('radio', { name: '실험 C · 제품별 다듬기', exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test('실험 C · 제품별 다듬기: 진행 중 취소하면 더 보내지 않고, 취소했다고 알린다', async ({ page }) => {
  await installDoubles(page);
  let rooms = 0,
    productRequests = 0;
  await page.route('**/api/export/photoreal', async (route) => {
    rooms++;
    const form = await formOf(route.request());
    const input = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    const { width, height } = await sharp(input).metadata();
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: await sharp(input)
        .resize(width! * 2, height! * 2)
        .png()
        .toBuffer(),
    });
  });
  await page.route('**/api/export/photoreal/check', (route) =>
    route.fulfill({ json: { fixtures: [], extras: [] } }),
  );
  await page.route('**/api/export/photoreal/product', async (route) => {
    productRequests++;
    await new Promise((resolve) => setTimeout(resolve, 20000));
    await route.abort();
  });
  await placeStandardToilet(page);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  await dialog
    .getByRole('group', { name: '변환 방식' })
    .getByText('실험 C · 제품별 다듬기', { exact: true })
    .click();
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const cancel = dialog.getByTestId('flux-refine-cancel');
  await expect(cancel).toBeVisible({ timeout: 60000 });
  await cancel.click();
  await expect(dialog.getByRole('alert').first()).toContainText('제품 다듬기를 취소했어요');
  await expect(dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true })).toBeEnabled();
  await expect(dialog.getByTestId('flux-refine-progress')).toHaveCount(0);
  expect(rooms).toBe(1);
  expect(productRequests).toBe(1);
  // Nothing more is sent after the stop.
  await page.waitForTimeout(1500);
  expect(productRequests).toBe(1);
});
