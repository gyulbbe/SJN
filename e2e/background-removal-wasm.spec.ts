import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

test.use({ channel: 'chrome', launchOptions: { args: ['--disable-features=WebGPUService'] } });
test('WebGPU 미지원 환경에서 실제 WASM FP32 추론과 반응하는 미리보기', async ({ page }, info) => {
  test.skip(
    process.env.SJN_AI_BACKGROUND_WASM !== '1',
    'SJN_AI_BACKGROUND_WASM=1로 183MiB CPU 모델을 실제 실행합니다.',
  );
  test.setTimeout(900_000);
  await page.goto('/materials');
  expect(
    await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      return !!(await gpu?.requestAdapter());
    }),
  ).toBe(false);
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('상품명').fill('실제 CPU 배경 제거 검사');
  await form
    .getByLabel('+ 제품 방향 이미지 올리기', { exact: true })
    .setInputFiles(path.resolve('test-results/background-removal/fixtures/white-toilet.jpg'));
  await expect(form.getByRole('button', { name: /AI 배경 제거 테스트/ })).toBeEnabled();
  await form.getByRole('button', { name: /AI 배경 제거 테스트/ }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
  await expect(dialog).toBeVisible();
  const updates: { seconds: number; state: string }[] = [];
  const start = Date.now();
  let lastStage = '';
  await expect
    .poll(
      async () => {
          const status = await dialog.getByRole('status').allTextContents();
        const stage = status.join(' ');
        if (stage !== lastStage) {
          lastStage = stage;
          updates.push({ seconds: (Date.now() - start) / 1000, state: stage });
          console.log('WASM stage:', stage);
        }
        if (await dialog.getByRole('alert').count()) return 'error';
        if (await dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true }).isEnabled())
          return 'ready';
        // The main thread must still respond while the worker downloads or infers.
        await dialog.getByRole('button', { name: '검은색', exact: true }).click();
        await expect(dialog.getByRole('button', { name: '검은색', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        return 'pending';
      },
      { timeout: 840_000, intervals: [1000, 2000, 4000] },
    )
    .not.toBe('pending');
  if (await dialog.getByRole('alert').count()) throw new Error(await dialog.getByRole('alert').innerText());
  await expect(dialog).toContainText('CPU · WASM / FP32');
  const result = dialog.getByTestId('background-removal-result');
  await expect.poll(() => result.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1536);
  const imageBytes = await result.evaluate(async (el) => {
    const data = new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer());
    let text = '';
    for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
    return btoa(text);
  });
  const png = Buffer.from(imageBytes, 'base64');
  expect(await sharp(png).metadata()).toMatchObject({
    format: 'png',
    width: 1536,
    height: 2048,
    hasAlpha: true,
  });
  await writeFile(info.outputPath('wasm-white-toilet.png'), png);
  await writeFile(
    info.outputPath('wasm-measurements.json'),
    JSON.stringify(
      {
        updates,
        summary: await dialog.innerText(),
        browser: await page.evaluate(() => navigator.userAgent),
      },
      null,
      2,
    ),
  );
  await dialog.screenshot({ path: info.outputPath('wasm-result.png') });
});
