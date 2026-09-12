import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const downloadsDirectory = path.join(tmpdir(), 'sjn-background-removal-downloads');
mkdirSync(downloadsDirectory, { recursive: true });

// Real model tests are opt-in: a cold run fetches 94 MB (WebGPU) / 183 MB (WASM).
// No inference result, network response, or model is mocked in this suite.
test.use({
  channel: 'chrome',
  // Windows browser sandbox files in workspace artifacts can be unreadable to Node.
  launchOptions: { args: [], downloadsPath: downloadsDirectory },
});

const fixtureDirectory = path.resolve('test-results/background-removal/fixtures');
const aiDialog = (page: Page) => page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });

async function openProductForm(page: Page) {
  await page.goto('/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('상품명').fill('AI 품질 검증용 제품');
  return form;
}

async function assetManifest(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const contents: Record<string, unknown[]> = {};
    for (const store of ['assets', 'materials', 'versions']) {
      contents[store] = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () =>
          resolve(
            request.result.map((value) => {
              const { blob, ...record } = value;
              return { ...record, ...(blob ? { blobSize: blob.size, blobType: blob.type } : {}) };
            }),
          );
        request.onerror = () => reject(request.error);
      });
    }
    db.close();
    return contents;
  });
}

async function uploadView(form: Locator, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const count = await form
    .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
    .count();
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(file);
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    count + 1,
  );
  await expect(form.getByLabel('+ 제품 이미지 올리기', { exact: true })).toBeEnabled();
  return count;
}

test('제품 방향 사진 옆 AI 테스트 버튼만 제공 · 수동 지우기 제거 · 업로드만으로 모델 다운로드하지 않음', async ({
  page,
}) => {
  const models: string[] = [];
  page.on('request', (request) => {
    if (/birefnet|background-removal.*\.(wasm|onnx)|ort-wasm/.test(request.url())) models.push(request.url());
  });
  const form = await openProductForm(page);
  await expect(form.getByRole('button', { name: /AI 배경 제거 테스트/ })).toHaveCount(0);
  const buffer = await sharp({ create: { width: 16, height: 20, channels: 4, background: '#b0c0c0' } })
    .png()
    .toBuffer();
  await uploadView(form, { name: 'button-availability.png', mimeType: 'image/png', buffer });
  await expect(form.getByRole('button', { name: /AI 배경 제거 테스트/ })).toBeEnabled();
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toHaveCount(0);
  expect(models).toEqual([]);
});

test.describe('실제 BiRefNet 추론', () => {
  test.skip(
    process.env.SJN_AI_BACKGROUND_REAL !== '1',
    'SJN_AI_BACKGROUND_REAL=1로 실제 모델 다운로드·추론을 실행합니다.',
  );

  test('실사 원본/결과 · 배경색·확대·PNG·원본 크기·기존 알파·적용 전 비파괴·선택 적용·재진입·캐시 시간', async ({
    page,
  }, info) => {
    test.setTimeout(1_200_000);
    const sources = ['white-toilet.jpg', 'retro-desk-lamp.jpg', 'garden-chair.jpg'];
    expect(
      existsSync(path.join(fixtureDirectory, sources[0])),
      '문서의 공개 사진 준비 명령을 먼저 실행하세요.',
    ).toBe(true);
    expect(existsSync(path.join(fixtureDirectory, sources[1]))).toBe(true);
    const modelRequests: string[] = [],
      uploads: string[] = [],
      errors: string[] = [];
    page.on('request', (request) => {
      if (/\.onnx(?:\?|$)/.test(request.url())) modelRequests.push(request.url());
      if (request.method() !== 'GET' && !request.url().startsWith('http://127.0.0.1:'))
        uploads.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const form = await openProductForm(page);
    const browser = await page.evaluate(async () => {
      const gpu = (
        navigator as Navigator & {
          gpu?: { requestAdapter: () => Promise<{ info?: unknown; features: Iterable<string> } | null> };
        }
      ).gpu;
      const adapter = await gpu?.requestAdapter();
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        adapter: (adapter as unknown as { info?: unknown } | null)?.info,
        features: adapter ? [...adapter.features] : [],
      };
    });
    const measurements: unknown[] = [];
    const cases: {
      name: string;
      file: string | { name: string; mimeType: string; buffer: Buffer };
      source: Buffer;
    }[] = [];
    for (const name of sources) {
      const file = path.join(fixtureDirectory, name);
      if (existsSync(file)) cases.push({ name, file, source: await readFile(file) });
    }
    // Controlled existing-alpha variation of the same real photograph; AI still infers the image.
    const rgba = await sharp(cases[0].source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < rgba.info.height; y++) {
      for (let x = 0; x < 40; x++) rgba.data[(y * rgba.info.width + x) * 4 + 3] = x < 20 ? 0 : 128;
    }
    const alphaPhoto = await sharp(rgba.data, { raw: rgba.info }).png().toBuffer();
    cases.push({
      name: 'white-toilet-existing-alpha.png',
      file: { name: 'white-toilet-existing-alpha.png', mimeType: 'image/png', buffer: alphaPhoto },
      source: alphaPhoto,
    });

    for (const fixture of cases) {
      const index = await uploadView(form, fixture.file);
      const sourcePreview = await form
        .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
        .nth(index)
        .getAttribute('src');
      const before = await assetManifest(page);
      const requestCount = modelRequests.length;
      await form
        .getByRole('button', { name: /AI 배경 제거 테스트/ })
        .nth(index)
        .click();
      const dialog = aiDialog(page);
      await expect(dialog).toBeVisible();
      await expect
        .poll(
          async () => {
            if (await dialog.getByRole('alert').count()) return 'error';
            if (await dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true }).isEnabled())
              return 'ready';
            return 'pending';
          },
          { timeout: 480000 },
        )
        .not.toBe('pending');
      if (await dialog.getByRole('alert').count())
        throw new Error(await dialog.getByRole('alert').innerText());
      await expect(dialog.getByTestId('background-removal-original')).toBeVisible();
      await expect(dialog.getByTestId('background-removal-result')).toBeVisible();
      await expect
        .poll(() =>
          dialog
            .getByTestId('background-removal-result')
            .evaluate(
              (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
            ),
        )
        .toBe(true);
      for (const background of ['체크무늬', '흰색', '검은색']) {
        const button = dialog.getByRole('button', { name: background, exact: true });
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await dialog.screenshot({ path: info.outputPath(`${fixture.name}-${background}.png`) });
      }
      await dialog.getByLabel('미리보기 확대', { exact: true }).selectOption({ label: '200%' });
      await expect(dialog.getByLabel('미리보기 확대', { exact: true }).locator('option:checked')).toHaveText(
        '200%',
      );
      await dialog.screenshot({ path: info.outputPath(`${fixture.name}-zoom.png`) });
      await dialog.getByLabel('미리보기 확대', { exact: true }).selectOption({ label: '화면 맞춤' });
      const downloadEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(/\.png$/);
      const destination = info.outputPath(`${fixture.name}-result.png`);
      // Chromium download event still verifies the real PNG; streaming avoids Windows copyfile locks.
      const stream = await download.createReadStream();
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      await writeFile(destination, Buffer.concat(chunks));
      const result = await sharp(destination).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const input = await sharp(fixture.source)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([result.info.width, result.info.height]).toEqual([input.info.width, input.info.height]);
      let removed = 0,
        retained = 0,
        alphaIncrease = 0;
      for (let i = 3; i < result.data.length; i += 4) {
        if (result.data[i] < 16) removed++;
        if (result.data[i] > 240) retained++;
        if (result.data[i] > input.data[i]) alphaIncrease++;
      }
      expect(removed).toBeGreaterThan(100);
      expect(retained).toBeGreaterThan(100);
      expect(alphaIncrease, '원본의 투명도보다 불투명해진 픽셀이 없어야 합니다.').toBe(0);
      const timings: Record<string, string> = {};
      for (const kind of ['download', 'initialization', 'processing', 'inference']) {
        timings[kind] = (await dialog.getByTestId(`background-removal-${kind}-time`).textContent()) || '';
        expect(timings[kind]).toMatch(/\d/);
      }
      measurements.push({
        source: fixture.name,
        width: result.info.width,
        height: result.info.height,
        removed,
        retained,
        alphaIncrease,
        timings,
        newModelRequests: modelRequests.length - requestCount,
      });
      await writeFile(
        info.outputPath('real-inference-measurements.json'),
        JSON.stringify({ browser, measurements, modelRequests, uploads, errors }, null, 2),
      );
      await expect.poll(() => assetManifest(page)).toEqual(before);
      if (fixture === cases.at(-1)) {
        await dialog.getByRole('button', { name: '투명 PNG 업로드', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect
          .poll(() =>
            form
              .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
              .nth(index)
              .getAttribute('src'),
          )
          .not.toBe(sourcePreview);
        const afterApply = await assetManifest(page);
        expect(afterApply.materials).toEqual(before.materials);
        expect(afterApply.versions).toEqual(before.versions);
      } else {
        await dialog.getByRole('button', { name: /닫기/ }).click();
        await expect(dialog).toHaveCount(0);
        expect(
          await form
            .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
            .nth(index)
            .getAttribute('src'),
        ).toBe(sourcePreview);
      }
    }
    await form.getByRole('button', { name: '자재 등록', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: '정보 수정', exact: true }).first().click();
    const reopened = page.getByRole('dialog', { name: '자재 수정', exact: true });
    await expect(
      reopened.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
    ).toHaveCount(cases.length);
    const persistedAlpha = await reopened
      .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
      .last()
      .evaluate(async (image: HTMLImageElement) => {
        const bitmap = await createImageBitmap(await (await fetch(image.src)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const alpha = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let removed = 0,
          retained = 0;
        for (let i = 3; i < alpha.length; i += 4) {
          if (alpha[i] < 16) removed++;
          if (alpha[i] > 240) retained++;
        }
        return { removed, retained };
      });
    expect(persistedAlpha.removed).toBeGreaterThan(100);
    expect(persistedAlpha.retained).toBeGreaterThan(100);
    await writeFile(
      info.outputPath('real-inference-measurements.json'),
      JSON.stringify({ browser, measurements, modelRequests, uploads, errors }, null, 2),
    );
    expect(uploads).toEqual([]);
    expect(errors).toEqual([]);
  });
});
