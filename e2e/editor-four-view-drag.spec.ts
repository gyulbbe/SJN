import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { storedProject } from '../tests/helpers/editor-actions';
import { defaultRoomView } from '../src/lib/room-viewer/view-state';
import type { ProjectDocument } from '../src/lib/types';
import type { RoomFace } from '../src/lib/room-types';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(900000);

const stage = (page: Page) => page.getByTestId('room-editor-canvas');
const active = (project: ProjectDocument) =>
  project.designs.find((design) => design.id === project.activeDesignId)!;

async function ready(page: Page) {
  await expect(stage(page)).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  await expect(stage(page)).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
}

/** A room with one red product and a wall niche (the niche turns the centre into the 3D room stage). */
async function createStageRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="40" y="10" width="120" height="185" rx="15" fill="#ff0000"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('끌기 시험 제품');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('500');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('700');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: png });
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '끌기 시험 제품' }).click();
  await expect(page.getByLabel('제품 배율', { exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  const structure = page.getByRole('dialog', { name: '벽 구조 편집', exact: true });
  const edit = page.getByRole('button', { name: /^벽 구조 편집/ });
  if (!(await edit.isVisible()))
    await page
      .getByRole('button', { name: /^(자재·공간 속성|.* 속성)$/ })
      .last()
      .click();
  await edit.click();
  await structure.getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await structure.getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await ready(page);
}

/** Rewrite the stored project (the one product's face and place, the front view), then open it again. */
async function reopenWith(page: Page, face: RoomFace, u: number, v: number) {
  const url = page.url();
  const stored = await storedProject(page);
  const design = active(stored);
  const fixture = design.scene.fixtures[0];
  fixture.roomPlacement = { ...fixture.roomPlacement!, face, u, v };
  const next = { ...stored, roomView: defaultRoomView() };
  await page.evaluate(
    async ({ document }) => {
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
    },
    { document: next },
  );
  await page.goto(url);
  await ready(page);
}

/** Where the red product is on screen, as a fraction of the stage canvas, or null when it is not seen. */
async function productAt(page: Page) {
  await page.waitForTimeout(700);
  const shot = await stage(page).locator('canvas').screenshot();
  const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0,
    sx = 0,
    sy = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * 4;
      if (data[o] > 200 && data[o + 1] < 60 && data[o + 2] < 60) {
        n++;
        sx += x;
        sy += y;
      }
    }
  if (n < 30) return { n, at: null };
  const box = (await stage(page).boundingBox())!;
  return {
    n,
    at: {
      x: box.x + (sx / n / info.width) * box.width,
      y: box.y + (sy / n / info.height) * box.height,
    },
  };
}

const VIEWS = ['정면', '오른쪽', '뒤', '왼쪽'] as const;

test('네 시점 × 설치면(바닥·뒷벽·왼쪽 벽·오른쪽 벽): 제품을 고르고 끌면 끈 쪽으로 따라 움직인다', async ({
  page,
}, info: TestInfo) => {
  await createStageRoom(page);
  const room = active(await storedProject(page)).scene.room!;
  const placement = async () => active(await storedProject(page)).scene.fixtures[0].roomPlacement!;
  const table: unknown[] = [];
  for (const face of ['floor', 'back', 'left', 'right'] as const) {
    await reopenWith(page, face, 0.5, face === 'floor' ? 0.5 : 0.55);
    await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
    const alongMm = face === 'floor' || face === 'back' ? room.widthMm : room.depthMm;
    const acrossMm = face === 'floor' ? room.depthMm : room.heightMm;
    for (const [index, view] of VIEWS.entries()) {
      if (index > 0) {
        await page.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
        await page.waitForTimeout(500);
      }
      const seen = await productAt(page);
      expect(seen.at, face + ' ' + view + ': 제품이 보인다').not.toBeNull();
      const at = seen.at!;
      // The product is picked where it is drawn: its panel opens (a wall's tile panel would open
      // if the click went to the wall behind it).
      await page.mouse.click(at.x, at.y);
      await expect(
        page.getByRole('heading', { name: '제품 속성', exact: true }),
        face + ' ' + view + ': 제품이 선택된다',
      ).toBeVisible();
      const original = await placement();
      const row: Record<string, unknown> = { face, view };
      for (const [name, dx, dy] of [
        ['오른쪽으로 70px', 70, 0],
        ['위로 45px', 0, -45],
      ] as const) {
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + dx, at.y + dy, { steps: 8 });
        const during = (await productAt(page)).at;
        await page.mouse.up();
        // The place is saved (a no-op drag would leave it as it was).
        await expect
          .poll(
            async () => {
              const now = await placement();
              return now.u !== original.u || now.v !== original.v;
            },
            { message: face + ' ' + view + ': ' + name + ' 끌기가 저장된다', timeout: 15000 },
          )
          .toBe(true);
        const now = await placement();
        // It stays on its own face and inside it, whatever the angle.
        expect(now.face).toBe(face);
        for (const value of [now.u, now.v]) expect(value >= 0 && value <= 1).toBe(true);
        // It follows the pointer: on screen it moves the way the pointer moved, never against it.
        expect(during, face + ' ' + view + ': 끄는 동안 제품이 보인다').not.toBeNull();
        if (dx) expect(Math.sign(during!.x - at.x)).toBe(Math.sign(dx));
        if (dy) expect(Math.sign(during!.y - at.y)).toBe(Math.sign(dy));
        row[name] = {
          mm: [Math.round((now.u - original.u) * alongMm), Math.round((now.v - original.v) * acrossMm)],
          screenPx: [Math.round(during!.x - at.x), Math.round(during!.y - at.y)],
          atEdge: now.u === 0 || now.u === 1 || now.v === 0 || now.v === 1,
        };
        await page.getByRole('button', { name: '실행 취소', exact: true }).click();
        await expect
          .poll(
            async () => {
              const back = await placement();
              return [back.u, back.v];
            },
            { timeout: 15000 },
          )
          .toEqual([original.u, original.v]);
      }
      table.push(row);
    }
  }
  await writeFile(info.outputPath('drag-matrix.json'), JSON.stringify({ room, table }, null, 2));
});
