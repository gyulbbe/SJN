import { buffer as streamBuffer } from 'node:stream/consumers';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';
import type { MaterialVersion } from '../src/lib/types';
import sharp from 'sharp';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';
import type { ProjectDocument } from '../src/lib/types';
import {
  defaultRoomView,
  rotateRoomView,
  type RoomViewDirection,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});

test.use({ channel: 'chrome', actionTimeout: 15000, hasTouch: true });
test.setTimeout(240000);
const viewer = (page: Page) => page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
const viewport = (page: Page) => page.getByTestId('room-view-viewport');
const labels: Record<RoomViewDirection, string> = {
  left: '왼쪽 90°',
  right: '오른쪽 90°',
  up: '위로 90°',
  down: '아래로 90°',
};
const opposite: Record<RoomViewDirection, RoomViewDirection> = {
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};

async function ready(page: Page) {
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.editor-error')).toHaveCount(0);
}
async function start(page: Page, tiles = false) {
  await page.goto('/');
  if (tiles) await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await ready(page);
  let project = await savedProject(page);
  if (tiles) {
    await page.getByRole('button', { name: '벽 타일', exact: true }).click();
    await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
    project = await savedProject(page, project.editRevision);
    await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
    await page.locator('button.material-tile').filter({ hasText: '라이트 스톤' }).click();
    project = await savedProject(page, project.editRevision);
  }
  return project;
}
async function opened(page: Page) {
  const start = performance.now();
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect.poll(async () => Number(await viewport(page).getAttribute('data-frame'))).toBeGreaterThan(0);
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);
  return performance.now() - start;
}
async function viewState(page: Page): Promise<RoomViewState> {
  return JSON.parse((await viewport(page).getAttribute('data-view'))!);
}
async function action(page: Page, name: string) {
  const frame = Number(await viewport(page).getAttribute('data-frame'));
  const time = performance.now();
  await viewer(page).getByRole('button', { name, exact: true }).click();
  await expect
    .poll(async () => Number(await viewport(page).getAttribute('data-frame')))
    .toBeGreaterThan(frame);
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);
  return performance.now() - time;
}
async function image(page: Page, info?: TestInfo, name?: string) {
  return viewer(page)
    .locator('canvas')
    .screenshot(info && name ? { path: info.outputPath(name) } : {});
}
async function pixelDifference(a: Buffer, b: Buffer) {
  const [left, right] = await Promise.all(
    [a, b].map((buffer) => sharp(buffer).resize(180, 120, { fit: 'fill' }).removeAlpha().raw().toBuffer()),
  );
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
}
/** Existing read migration fills optional empty usage/render metadata on the next ordinary write. */
function initializedDesigns(project: ProjectDocument) {
  return project.designs.map((design) => ({
    ...design,
    renderRevision: design.renderRevision ?? design.revision,
    materialUsage: design.materialUsage ?? {
      version: 1,
      assignments: {},
      areas: {},
      aggregateAreas: [],
      quantities: {},
    },
  }));
}

async function waitSavedView(page: Page, view: RoomViewState) {
  await expect.poll(async () => (await storedProject(page)).roomView).toEqual(view);
  return savedProject(page);
}
function observeRequests(page: Page) {
  const forbidden: string[] = [],
    errors: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/.test(url)) {
      const parsed = new URL(url);
      if (
        !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
        /models\/|\.onnx(?:\?|$)|\/api\/(?:ai|reconstruction|upload)/i.test(parsed.pathname)
      )
        forbidden.push(url);
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { forbidden, errors };
}
async function download(
  page: Page,
  info: TestInfo,
  format: 'png' | 'jpeg',
  mode: 'after' | 'compare',
  filename: string,
) {
  await viewer(page).getByLabel('둘러보기 파일 형식', { exact: true }).selectOption(format);
  await viewer(page).getByLabel('둘러보기 출력 종류', { exact: true }).selectOption(mode);
  // High-quality downloads average samples for up to ~10 s on software WebGL, then encode. The page
  // is busy through the first sample, so the click's own settle wait can outlast the action timeout.
  const event = page.waitForEvent('download', { timeout: 120000 });
  await viewer(page)
    .getByRole('button', { name: '현재 시점 다운로드', exact: true })
    .click({ timeout: 60000 });
  const path = info.outputPath(filename);
  const download = await event;
  const bytes = await streamBuffer(await download.createReadStream());
  await download.saveAs(path);
  return bytes;
}

test('공간 둘러보기 실제 90도 회전·동기 비교·현재 각도 출력·저장·재진입·50회 전환·10회 개폐', async ({
  page,
}, info) => {
  const requests = observeRequests(page);
  const source = await start(page, true);
  const initialPreparationMs = await opened(page);
  await action(page, 'After');
  const initial = await image(page, info, 'front-after.png');
  for (const direction of ['left', 'right', 'up', 'down'] as const) {
    let expected = defaultRoomView();
    for (let i = 0; i < 4; i++) {
      await action(page, labels[direction]);
      expected = rotateRoomView(expected, direction);
      expect(await viewState(page)).toEqual(expected);
      await image(page, info, `${direction}-${(i + 1) * 90}-after.png`);
    }
    expect(await pixelDifference(initial, await image(page))).toBeLessThan(0.1);
    await action(page, labels[direction]);
    await action(page, labels[opposite[direction]]);
    expect(await viewState(page)).toEqual(defaultRoomView());
  }
  const sequence: RoomViewDirection[] = ['up', 'left', 'down', 'right'];
  for (const direction of sequence) await action(page, labels[direction]);
  for (const direction of [...sequence].reverse()) await action(page, labels[opposite[direction]]);
  expect(await viewState(page)).toEqual(defaultRoomView());
  await action(page, '왼쪽 90°');
  const rotated = await viewState(page);
  await action(page, 'Before');
  const before = await image(page, info, 'left-before.png');
  await action(page, 'After');
  const after = await image(page, info, 'left-after.png');
  expect(await pixelDifference(before, after)).toBeGreaterThan(2);
  expect(await viewState(page)).toEqual(rotated);
  await action(page, '겹쳐 비교');
  const slider = viewer(page).getByLabel('둘러보기 Before After 비교 위치', { exact: true });
  // Showing the slider changes available preview height; allow one RGB step for resampling/AA.
  await slider.fill('0');
  await expect.poll(async () => pixelDifference(after, await image(page))).toBeLessThan(1);
  await slider.fill('100');
  await expect.poll(async () => pixelDifference(before, await image(page))).toBeLessThan(1);
  await slider.fill('50');
  await image(page, info, 'left-split.png');
  await action(page, '나란히 비교');
  await image(page, info, 'left-compare.png');
  expect(await viewState(page)).toEqual(rotated);

  await action(page, '공간 확대');
  expect((await viewState(page)).zoom).toBe(1.25);
  const box = await viewport(page).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 35, box!.y + box!.height / 2 + 20, { steps: 3 });
  await page.mouse.up();
  expect((await viewState(page)).pan.x).toBeGreaterThan(0);
  await action(page, '화면 맞춤');
  expect(await viewState(page)).toEqual(rotated);
  await action(page, 'After');
  const preview = await image(page);
  const previewState = await viewState(page);
  const png = await download(page, info, 'png', 'after', 'left-after-output.png');
  const jpeg = await download(page, info, 'jpeg', 'after', 'left-after-output.jpg');
  const compared = await download(page, info, 'png', 'compare', 'left-compare-output.png');
  const pngMeta = await sharp(png).metadata(),
    jpgMeta = await sharp(jpeg).metadata(),
    compareMeta = await sharp(compared).metadata();
  expect(pngMeta.width).toBe(4096);
  expect(jpgMeta.format).toBe('jpeg');
  expect([jpgMeta.width, jpgMeta.height]).toEqual([pngMeta.width, pngMeta.height]);
  expect(compareMeta.width).toBe(4096);
  expect(compareMeta.height).toBe(
    Math.round(4096 / (2 * (source.designs[0].scene.imageWidth / source.designs[0].scene.imageHeight))),
  );
  expect(await pixelDifference(png, jpeg)).toBeLessThan(3);
  expect(await pixelDifference(preview, png)).toBeLessThan(6);
  const compareAfter = await sharp(compared)
    .extract({
      left: compareMeta.width! / 2,
      top: 0,
      width: compareMeta.width! / 2,
      height: compareMeta.height!,
    })
    .png()
    .toBuffer();
  expect(await pixelDifference(png, compareAfter)).toBeLessThan(6);
  expect(await viewState(page)).toEqual(previewState);

  const latencies: number[] = [];
  for (let i = 0; i < 50; i++) latencies.push(await action(page, labels[i % 2 ? 'up' : 'right']));
  const finalView = await viewState(page);
  const saved = await waitSavedView(page, finalView);
  expect(saved.editRevision).toBe(source.editRevision);
  expect(saved.shared).toEqual(source.shared);
  expect(initializedDesigns(saved)).toEqual(initializedDesigns(source));
  expect(saved.viewport).toEqual(source.viewport);
  const openTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
    await expect(viewer(page)).toHaveCount(0);
    openTimes.push(await opened(page));
    expect(await viewState(page)).toEqual(finalView);
    expect(await viewer(page).locator('canvas').count()).toBe(1);
  }
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.reload();
  await ready(page);
  await opened(page);
  expect(await viewState(page)).toEqual(finalView);
  expect(initializedDesigns(await storedProject(page))).toEqual(initializedDesigns(source));
  await page.screenshot({ path: info.outputPath('reopened-view.png') });
  expect(requests.forbidden).toEqual([]);
  expect(requests.errors).toEqual([]);
  await writeFile(
    info.outputPath('verification.json'),
    JSON.stringify(
      {
        initialPreparationMs,
        latencies,
        openTimes,
        beforeEditRevision: source.editRevision,
        afterEditRevision: saved.editRevision,
        finalView,
        pngMeta,
        jpgMeta,
        compareMeta,
        requests,
        environment: {
          browser: await page.context().browser()!.version(),
          viewport: page.viewportSize(),
          softwareGpu: 'Playwright --use-angle=swiftshader',
          scene: 'UI-created 2400mm basic room; four seeded test textures, no AI fixtures',
        },
      },
      null,
      2,
    ),
  );
});

test('빈 공간 Before After 정렬과 키보드 포커스·390px 터치·회원 두 번째 탭 시점 저장', async ({
  page,
  context,
}, info) => {
  const requests = observeRequests(page);
  const source = await start(page);
  await opened(page);
  await action(page, 'Before');
  const before = await image(page);
  await action(page, 'After');
  expect(await pixelDifference(before, await image(page))).toBeLessThan(0.1);
  await action(page, '위로 90°');
  await action(page, 'Before');
  const top = await image(page);
  await action(page, 'After');
  expect(await pixelDifference(top, await image(page))).toBeLessThan(0.1);
  const current = await viewState(page);
  await viewport(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => viewState(page)).toEqual(rotateRoomView(current, 'right'));
  const keyboardView = await viewState(page);
  await viewer(page).getByLabel('둘러보기 파일 형식', { exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  expect(await viewState(page)).toEqual(keyboardView);
  await waitSavedView(page, keyboardView);
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();

  const second = await context.newPage();
  await second.goto(page.url());
  await ready(second);
  await opened(second);
  await expect(viewer(second)).not.toContainText('읽기 전용 · 시점은 이 창에서만 유지돼요.');
  const stored = await storedProject(second);
  await action(second, '아래로 90°');
  expect(await viewState(second)).not.toEqual(stored.roomView);
  await second.setViewportSize({ width: 390, height: 844 });
  await expect(viewer(second)).toBeVisible();
  expect(await viewer(second).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const button = viewer(second).getByRole('button', { name: '오른쪽 90°', exact: true });
  const previous = await viewState(second);
  await button.tap();
  await expect.poll(() => viewState(second)).toEqual(rotateRoomView(previous, 'right'));
  const secondView = await viewState(second);
  const secondSaved = await waitSavedView(second, secondView);
  expect(initializedDesigns(secondSaved)).toEqual(initializedDesigns(stored));
  await second.screenshot({ path: info.outputPath('mobile-cloud-member.png') });
  await viewer(second).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await expect(viewer(second)).toHaveCount(0);
  expect((await storedProject(second)).roomView).toEqual(secondView);
  await second.close();
  expect(initializedDesigns(await savedProject(page))).toEqual(initializedDesigns(source));
  expect(requests.errors).toEqual([]);
  expect(requests.forbidden).toEqual([]);
  await writeFile(
    info.outputPath('verification.json'),
    JSON.stringify(
      {
        blankBeforeAfterPixelsMatch: true,
        keyboardView,
        secondViewSaved: true,
        designsUnchanged: true,
        mobileWidth: 390,
        requests,
      },
      null,
      2,
    ),
  );
});

test('보기 WebGL 시작 실패 재시도와 저장 실패에서도 기존 장면·시점을 보존한다', async ({ page }, info) => {
  const source = await start(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    const runtime = window as Window & { restoreRoomViewContext?: () => void };
    runtime.restoreRoomViewContext = () => {
      HTMLCanvasElement.prototype.getContext = original;
    };
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).includes('webgl')) return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  await expect(viewer(page).getByRole('alert')).toContainText('공간 보기를 시작하지 못했어요.');
  expect(initializedDesigns(await storedProject(page))).toEqual(initializedDesigns(source));
  await page.evaluate(() =>
    (window as Window & { restoreRoomViewContext?: () => void }).restoreRoomViewContext?.(),
  );
  await viewer(page).getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect.poll(async () => Number(await viewport(page).getAttribute('data-frame'))).toBeGreaterThan(0);
  await viewer(page)
    .locator('canvas')
    .evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext('webgl2');
      const extension = context?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context-loss test needs WEBGL_lose_context');
      extension.loseContext();
    });
  await expect(viewer(page).getByRole('alert')).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'true');
  await viewer(page).getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);
  let failViewSave = true;
  await page.route('**/api/d1/projects', (route) => {
    if (failViewSave && route.request().postDataJSON()?.operation === 'save')
      return route.fulfill({ status: 503, json: { error: '검증용 서버 저장 실패' } });
    return route.fallback();
  });
  await action(page, '오른쪽 90°');
  const failedView = await viewState(page);
  await expect(page.getByTestId('save-status')).toHaveText('저장 실패 · 다시 시도', { timeout: 15000 });
  expect((await storedProject(page)).roomView).toBeUndefined();
  expect(await viewState(page)).toEqual(failedView);
  await image(page, info, 'save-failure-view-preserved.png');
  failViewSave = false;
  const frame = Number(await viewport(page).getAttribute('data-frame'));
  await viewer(page).getByRole('button', { name: '위로 90°', exact: true }).click();
  await expect
    .poll(async () => Number(await viewport(page).getAttribute('data-frame')))
    .toBeGreaterThan(frame);
  const recoveredView = await viewState(page);
  await expect(viewer(page).getByRole('alert')).toContainText('검증용 서버 저장 실패');
  expect((await storedProject(page)).roomView).toBeUndefined();
  await viewer(page).getByRole('button', { name: '시점 저장 다시 시도', exact: true }).click();
  const saved = await waitSavedView(page, recoveredView);
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);
  expect(initializedDesigns(saved)).toEqual(initializedDesigns(source));
  expect(saved.editRevision).toBe(source.editRevision);
  await writeFile(
    info.outputPath('verification.json'),
    JSON.stringify(
      {
        initialContextFailure:
          'Injected getContext(webgl)=null only for new viewer; existing editor retained',
        retriedSuccessfully: true,
        idleContextLostAndRetried: true,
        saveFailure: 'Injected HTTP 503 for D1 projects save; persisted record unchanged',
        failedView,
        recoveredView,
        editRevision: saved.editRevision,
      },
      null,
      2,
    ),
  );
});

test('시안 복사·각 시안 재편집·둘러보기 시안 전환이 공통 시점과 자재 수량을 유지한다', async ({
  page,
}, info) => {
  const requests = observeRequests(page);
  const original = await start(page, true);
  await opened(page);
  await action(page, '오른쪽 90°');
  const commonView = await viewState(page);
  await waitSavedView(page, commonView);
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  const manager = page.getByRole('dialog', { name: /^시안 관리/ });
  await manager.getByRole('button', { name: '시안 A 복제', exact: true }).click();
  await manager.getByRole('button', { name: '시안 A 복사본 편집하기', exact: true }).click();
  const copied = await savedProject(page, original.editRevision);
  expect(copied.roomView).toEqual(commonView);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '웜 샌드' }).click();
  const modified = await savedProject(page, copied.editRevision);
  const originalId = original.activeDesignId!,
    copiedId = modified.activeDesignId!;
  expect(modified.designs.find((design) => design.id === originalId)?.scene).toEqual(
    original.designs.find((design) => design.id === originalId)?.scene,
  );
  const usageText = await page.getByTestId('usage-total').textContent();
  await opened(page);
  await action(page, 'After');
  expect(await viewState(page)).toEqual(commonView);
  const copiedImage = await image(page, info, 'copy-right.png');
  const selector = viewer(page).getByLabel('둘러볼 시안', { exact: true });
  await selector.selectOption(originalId);
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => pixelDifference(copiedImage, await image(page))).toBeGreaterThan(1);
  await image(page, info, 'original-right.png');
  expect(await viewState(page)).toEqual(commonView);
  await selector.selectOption(copiedId);
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => pixelDifference(copiedImage, await image(page))).toBeLessThan(0.2);
  expect(await viewState(page)).toEqual(commonView);
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  const final = await savedProject(page);
  expect(final.editRevision).toBe(modified.editRevision);
  expect(initializedDesigns(final)).toEqual(initializedDesigns(modified));
  expect(await page.getByTestId('usage-total').textContent()).toBe(usageText);
  expect(requests.forbidden).toEqual([]);
  expect(requests.errors).toEqual([]);
  await writeFile(
    info.outputPath('verification.json'),
    JSON.stringify(
      { commonView, originalId, copiedId, editRevision: final.editRevision, usageText, requests },
      null,
      2,
    ),
  );
});

test('실제 저장 user01 사용자 보정 Before 여섯 설비를 같은 mm 위치로 둘러보기·출력·재진입한다', async ({
  page,
}, info) => {
  test.skip(
    process.env.SJN_VIEWER_REAL_REPORT !== '1',
    'Private preserved real-photo user-confirmed report; opt in explicitly. No new AI.',
  );
  const sourceRoot = resolve('test-results/reconstruction-placement-quality-20260914/e2e-run-01');
  let reportPath = '';
  for (const directory of await readdir(sourceRoot)) {
    const verification = await readFile(resolve(sourceRoot, directory, 'verification.json'), 'utf8').catch(
      () => 'null',
    );
    if (JSON.parse(verification)?.caseId === 'user-01')
      reportPath = resolve(sourceRoot, directory, 'corrected-report.json');
  }
  expect(reportPath).not.toBe('');
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString('utf8')) as ReconstructionLabReport;
  expect(report.fixtures).toHaveLength(6);
  const photoPath = resolve('test-results/user-reconstruction-improvement-20260913/inputs/user-01.jpg');
  const photo = await readFile(photoPath);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const originalHashes = { report: hash(reportBytes), photo: hash(photo) };
  expect(report.inputFingerprint).toBe(originalHashes.photo);
  const requests = observeRequests(page);
  let workers = 0;
  page.on('worker', () => workers++);
  const base = await start(page);
  const url = page.url();
  // Leave the editor before the isolated fixture import so autosave cannot race the seed.
  await page.goto('/');
  const bundle = await build({
    stdin: {
      contents:
        "export {createCloudRepositories} from './src/lib/repositories/cloud'; export {renderReconstructionTemplate} from './src/lib/reconstruction/templates'; export {makeAsset} from './src/lib/images'; export {materialInputSchema} from './src/lib/storage/validation';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'RoomViewImport',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const imported = await page.evaluate(
    async ({ report, baseId, photoBase64, actorId }) => {
      const api = (
        window as unknown as {
          RoomViewImport: typeof import('../src/lib/repositories/cloud') &
            typeof import('../src/lib/reconstruction/templates') &
            typeof import('../src/lib/images') &
            typeof import('../src/lib/storage/validation');
        }
      ).RoomViewImport;
      if (!report.inputFingerprint) throw new Error('Preserved report needs its original photo fingerprint');
      const repo = api.createCloudRepositories('d1', actorId);
      const project = await repo.projects.load(baseId);
      const sourceBytes = Uint8Array.from(atob(photoBase64), (character) => character.charCodeAt(0));
      const original = await api.makeAsset(
        new Blob([sourceBytes], { type: 'image/jpeg' }),
        'user01 원본 사진 · 검증용',
        'original',
      );
      await repo.assets.put(original);
      const versions: MaterialVersion[] = [];
      const materialAssetIds: string[] = [];
      for (const fixture of report.fixtures) {
        const reconstruction = fixture.reconstruction!,
          placement = fixture.roomPlacement!;
        if (reconstruction.appearanceAssetId)
          throw new Error('Expected standard neutral material, not a source-photo cutout');
        const rendered = await api.renderReconstructionTemplate({
          ...reconstruction,
          kind: reconstruction.kind as import('../src/lib/reconstruction/types').ReconstructionKind,
          room: report.room,
          face: placement.face,
          u: placement.u,
          v: placement.v,
          aspect: project.shared.baseline.imageWidth / project.shared.baseline.imageHeight,
        });
        const asset = await api.makeAsset(rendered.blob, fixture.name + ' · 보존 설비 검증 PNG', 'product');
        await repo.assets.put(asset);
        materialAssetIds.push(asset.id);
        const version: MaterialVersion = {
          id: fixture.materialVersionId,
          materialId: crypto.randomUUID(),
          version: 1,
          name: fixture.name,
          brand: '',
          code: 'PRESERVED-REAL-USER01-' + fixture.id,
          category: reconstruction.kind as MaterialVersion['category'],
          scope: 'personal',
          description:
            'Previously user-confirmed photo reconstruction; regenerated standard thumbnail only, no new AI.',
          color: reconstruction.color,
          finish: '',
          widthMm: reconstruction.widthMm,
          heightMm: reconstruction.heightMm,
          depthMm: reconstruction.depthMm,
          usage: 'both',
          installation: placement.face === 'floor' ? 'floor' : 'wall',
          textureAssetIds: [],
          views: [{ assetId: asset.id, direction: '공간 공통 카메라', anchor: fixture.anchor }],
          reconstruction: { version: reconstruction.version, kind: reconstruction.kind },
          defaultGroutWidth: 2,
          defaultGroutColor: '#d5d1c9',
          defaultPattern: 'grid',
          createdAt: new Date().toISOString(),
        };
        api.materialInputSchema.parse(version);
        versions.push(version);
      }
      project.name = 'user01 · 실제 사용자 보정 Before 검증';
      const before = structuredClone(project.shared.baseline);
      before.fixtures = structuredClone(report.fixtures);
      project.shared.comparison = {
        before,
        room: report.room,
        cameraVersion: 1,
        aspect: before.imageWidth / before.imageHeight,
        referenceOriginalAssetId: original.id,
        referencePreviewAssetId: original.id,
        status: 'confirmed',
        review: structuredClone(report.review),
        labSource: {
          version: 1,
          runId: report.runId,
          inputFingerprint: report.inputFingerprint,
          reportJson: JSON.stringify(report),
          assetIds: [original.id, ...materialAssetIds],
          materialVersionIds: versions.map((version) => version.id),
        },
      };
      return { project, versions, originalId: original.id };
    },
    { report, baseId: base.id, photoBase64: photo.toString('base64'), actorId: app.actor.id },
  );
  // This historical fixture deliberately preserves the report's material IDs.
  // Assets came through the authenticated upload API; only the preserved version
  // rows are seeded directly into this test's disposable D1 database.
  for (const version of imported.versions) {
    await app.env.DB.batch([
      app.env.DB.prepare(
        'INSERT INTO d1_materials(id,owner_id,scope,current_version_id,active,created_at,updated_at,purpose) VALUES(?,?,?,?,1,?,?,?)',
      ).bind(
        version.materialId,
        app.actor.id,
        version.scope,
        version.id,
        version.createdAt,
        version.createdAt,
        'project',
      ),
      app.env.DB.prepare(
        'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        version.id,
        version.materialId,
        version.version,
        JSON.stringify(version),
        version.category,
        version.views.length,
        version.createdAt,
      ),
      ...version.views.map((view) =>
        app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
          version.id,
          view.assetId,
        ),
      ),
    ]);
  }
  imported.project = await page.evaluate(async (document) => {
    const response = await fetch('/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'save',
        document,
        expectedStorageRevision: document.storageRevision,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, imported.project);
  await page.goto(url);
  await ready(page);
  await savedProject(page);
  const firstOpenMs = await opened(page);
  await action(page, 'Before');
  const front = await image(page, info, 'user01-front-before.png');
  const poses: { name: string; view: RoomViewState }[] = [];
  for (const [name, steps] of [
    ['right', ['right']],
    ['back', ['right']],
    ['left', ['right']],
    ['front', ['right']],
    ['top', ['up']],
    ['bottom', ['up', 'up']],
  ] as const) {
    for (const direction of steps) await action(page, labels[direction]);
    poses.push({ name, view: await viewState(page) });
    await image(page, info, 'user01-' + name + '-before.png');
  }
  await action(page, '기본 시점');
  expect(await pixelDifference(front, await image(page))).toBeLessThan(0.1);
  await action(page, 'After');
  expect(await pixelDifference(front, await image(page))).toBeGreaterThan(2);
  await image(page, info, 'user01-empty-after.png');
  await action(page, '위로 90°');
  await action(page, '나란히 비교');
  await image(page, info, 'user01-top-preview-comparison.png');
  const output = await download(page, info, 'png', 'compare', 'user01-top-comparison.png');
  expect((await sharp(output).metadata()).width).toBe(4096);
  const view = await viewState(page);
  const saved = await waitSavedView(page, view);
  expect(saved.shared.comparison?.before.fixtures).toEqual(report.fixtures);
  expect(saved.designs[0].scene.fixtures).toEqual([]);
  expect(saved.designs[0].scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  expect(saved.editRevision).toBe(imported.project.editRevision);
  expect(saved.shared.comparison?.labSource?.reportJson).toBe(JSON.stringify(report));
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.reload();
  await ready(page);
  await opened(page);
  expect(await viewState(page)).toEqual(view);
  const reloaded = await savedProject(page);
  expect(reloaded.shared.comparison?.before.fixtures).toEqual(report.fixtures);
  const persisted = await app.versions();
  for (const version of imported.versions)
    expect(persisted.find((value) => value.id === version.id)).toEqual(version);
  expect(hash(await readFile(reportPath))).toBe(originalHashes.report);
  expect(hash(await readFile(photoPath))).toBe(originalHashes.photo);
  expect(requests.forbidden).toEqual([]);
  expect(requests.errors).toEqual([]);
  expect(workers).toBe(0);
  await writeFile(
    info.outputPath('verification.json'),
    JSON.stringify(
      {
        provenance:
          'Preserved actual user01 photo reconstruction with prior user-confirmed six placements. No new AI; current standard thumbnails rebuilt only.',
        reportPath,
        photoPath,
        originalHashes,
        fixtureIds: report.fixtures.map((fixture) => fixture.id),
        fixtureKinds: report.fixtures.map((fixture) => fixture.reconstruction?.kind),
        fixturePositionsPreserved: true,
        immutableVersionsPreserved: true,
        blankAfter: true,
        firstOpenMs,
        poses,
        finalView: view,
        requests,
        workers,
      },
      null,
      2,
    ),
  );
});

test('방 안 시점: 프리셋·15° 회전·이동·저장 후 새로고침 유지·다운로드·390px·바깥 시점 복귀', async ({
  page,
}, info) => {
  const requests = observeRequests(page);
  await start(page);
  await opened(page);
  await action(page, '방 안 · 가운데');
  const center = await viewState(page);
  expect(center.projection).toBe('room-eye');
  expect(center.eye).toMatchObject({ yaw: 0, fov: 74 });
  expect(center.eye!.position[1]).toBe(1500);
  await expect(viewer(page).getByTestId('room-view-direction')).toHaveText('방 안 시점 · 정면');
  // Inside the room the direction buttons turn the head in 15° steps.
  await action(page, '오른쪽 15°');
  expect((await viewState(page)).eye!.yaw).toBe(15);
  await action(page, '앞으로');
  const moved = await viewState(page);
  expect(moved.eye!.position[2]).toBeLessThan(center.eye!.position[2]);
  await expect(viewer(page).getByTestId('room-view-direction')).toHaveText('방 안 시점 · 오른쪽 15°');
  await waitSavedView(page, moved);
  const bytes = await download(page, info, 'png', 'after', 'room-eye-after.png');
  const meta = await sharp(bytes).metadata();
  expect(meta.width).toBe(4096);
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();

  // A saved in-room view survives a reload exactly.
  await page.reload();
  await ready(page);
  await opened(page);
  expect(await viewState(page)).toEqual(moved);
  await action(page, '방 안 · 왼쪽 모서리');
  expect((await viewState(page)).eye!.yaw).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await viewer(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await viewer(page).getByRole('button', { name: '방 안 · 오른쪽 모서리', exact: true }).tap();
  await expect.poll(async () => (await viewState(page)).eye?.yaw ?? 0).toBeLessThan(0);
  await page.screenshot({ path: info.outputPath('room-eye-390.png') });
  await viewer(page).getByRole('button', { name: '바깥 시점으로', exact: true }).tap();
  await expect.poll(() => viewState(page)).toEqual(defaultRoomView());
  expect(requests.errors).toEqual([]);
  expect(requests.forbidden).toEqual([]);
});

test('고화질 다운로드: 여러 장 진행률·취소·창 닫기에서 멈춤', async ({ page }, info) => {
  const requests = observeRequests(page);
  await start(page);
  await opened(page);
  await action(page, '방 안 · 가운데');
  await viewer(page).getByLabel('둘러보기 파일 형식', { exact: true }).selectOption('png');
  await viewer(page).getByLabel('둘러보기 출력 종류', { exact: true }).selectOption('after');
  const progress = viewer(page).getByTestId('room-export-progress');
  const downloadButton = viewer(page).getByRole('button', { name: '현재 시점 다운로드', exact: true });
  let downloads = 0;
  page.on('download', () => downloads++);

  // A full export shows n/N samples rising to the end, then downloads.
  const seen: string[] = [];
  let cancelBox: { x: number; y: number; width: number; height: number } | null = null;
  const event = page.waitForEvent('download', { timeout: 180000 });
  const exportStarted = performance.now();
  await downloadButton.click({ timeout: 60000 });
  const watcher = (async () => {
    // Software WebGL leaves the page busy during each sample; this reads whenever it answers.
    // One call per look (percent and the cancel button's place), as its free moments are short.
    for (let tries = 0; tries < 1800 && !downloads; tries++) {
      const state = await page.evaluate(() => {
        const meter = document.querySelector('[data-testid="room-export-progress"]');
        const button = [...(meter?.querySelectorAll('button') ?? [])].find(
          (element) => element.textContent?.trim() === '다운로드 취소',
        );
        const rect = button?.getBoundingClientRect();
        return {
          value: meter?.querySelector('[data-testid="room-export-percent"]')?.textContent ?? null,
          box: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        };
      });
      if (state.value && seen.at(-1) !== state.value) seen.push(state.value);
      cancelBox ??= state.box;
      await page.waitForTimeout(50);
    }
  })();
  const download = await event;
  const exportMs = performance.now() - exportStarted;
  await watcher;
  const meta = await sharp(await streamBuffer(await download.createReadStream())).metadata();
  expect(meta.width).toBe(4096);
  expect(seen.length).toBeGreaterThan(0);
  const numbers = seen.map((value) => Number.parseInt(value, 10));
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  expect(cancelBox).not.toBeNull();
  await expect(progress).toHaveCount(0);

  // Cancel: the page answers only between samples on software WebGL, where real input is handled
  // but a multi-step locator click is not, so press the button where it appeared above.
  downloads = 0;
  const box = cancelBox!;
  const cancelled = performance.now();
  await downloadButton.click({ timeout: 60000 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(progress).toHaveCount(0, { timeout: 60000 });
  const cancelMs = performance.now() - cancelled;
  await expect(downloadButton).toBeEnabled();
  await page.waitForTimeout(1500);
  expect(downloads).toBe(0);
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);

  // Closing the viewer while exporting stops it without an error or a download.
  const close = (await viewer(page)
    .getByRole('button', { name: '공간 둘러보기 닫기', exact: true })
    .boundingBox())!;
  await downloadButton.click({ timeout: 60000 });
  await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
  await expect(viewer(page)).toHaveCount(0, { timeout: 60000 });
  await page.waitForTimeout(1500);
  expect(downloads).toBe(0);
  await info.attach('export-timing', {
    body: JSON.stringify({ exportMs, cancelMs, seen }),
    contentType: 'application/json',
  });
  console.log('export timing', JSON.stringify({ exportMs, cancelMs, seen }));
  expect(requests.errors).toEqual([]);
  expect(requests.forbidden).toEqual([]);
});

test('사진 효과: 기본 켬·끄면 가장자리가 원본 그대로·다시 열어도 선택 유지', async ({ page }, info) => {
  const requests = observeRequests(page);
  await start(page);
  await opened(page);
  await action(page, '방 안 · 가운데');
  const toggle = viewer(page).getByRole('checkbox', { name: '사진 효과', exact: true });
  await expect(toggle).toBeChecked();
  const corner = async (bytes: Buffer) => {
    const { data, info: meta } = await sharp(bytes)
      .extract({ left: 0, top: 0, width: 64, height: 64 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let total = 0;
    for (let i = 0; i < data.length; i += meta.channels) total += data[i] + data[i + 1] + data[i + 2];
    return total / (data.length / meta.channels) / 3;
  };
  const withEffects = await download(page, info, 'png', 'after', 'photo-effects-on.png');
  await toggle.uncheck();
  const plain = await download(page, info, 'png', 'after', 'photo-effects-off.png');
  // The vignette only darkens the edge; the plain file keeps the rendered corner.
  expect(await corner(withEffects)).toBeLessThan((await corner(plain)) - 3);
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await opened(page);
  await expect(viewer(page).getByRole('checkbox', { name: '사진 효과', exact: true })).not.toBeChecked();
  await viewer(page).getByRole('checkbox', { name: '사진 효과', exact: true }).check();
  expect(requests.errors).toEqual([]);
  expect(requests.forbidden).toEqual([]);
});
