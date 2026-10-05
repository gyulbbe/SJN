import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test } from '@playwright/test';
import { Quaternion, Vector3 } from 'three';
import { storedProject } from '../tests/helpers/editor-actions';
import { cameraQuarterAzimuth, normalizeRoomView, snapQuarter } from '../src/lib/room-viewer/view-state';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(120000);

const quarterOf = async (page: Parameters<typeof storedProject>[0]) =>
  snapQuarter(
    cameraQuarterAzimuth(
      new Quaternion(...normalizeRoomView((await storedProject(page)).roomView).quaternion),
    ),
  );

test('편집기 가운데 화면: 위·아래 버튼 없이 네 방향으로만 돌고, 위에서 본 저장 시점은 열기만으로 바뀌지 않는다', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  // A wall niche turns the centre into the 3D room stage.
  const form = page.getByRole('dialog', { name: '벽 구조 편집', exact: true });
  const edit = page.getByRole('button', { name: /^벽 구조 편집/ });
  if (!(await edit.isVisible()))
    await page
      .getByRole('button', { name: /^(자재·공간 속성|.* 속성)$/ })
      .last()
      .click();
  await edit.click();
  await form.getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await form.getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 둘러보기', exact: true })
    .getByRole('button', { name: '공간 둘러보기 닫기', exact: true })
    .click();
  const stage = page.getByTestId('room-editor-canvas');
  await expect(stage).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await expect(page.getByRole('button', { name: '위로 90°', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '아래로 90°', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '왼쪽 90°', exact: true })).toBeVisible();

  // Save a top-down view straight into the project, then open it again.
  const url = page.url();
  const topDown = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const stored = await storedProject(page);
  const saved = await page.evaluate(
    async ({ document, view }) => {
      const response = await fetch('/api/d1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'save',
          document: { ...document, roomView: view },
          expectedStorageRevision: document.storageRevision,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { document: stored, view: { ...normalizeRoomView(stored.roomView), quaternion: topDown.toArray() } },
  );
  await page.goto(url);
  await expect(stage).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  // Opening alone did not change the project: the stored view is still the top-down one.
  const reopened = await storedProject(page);
  expect(reopened.roomView).toEqual(saved.roomView);
  expect(reopened.editRevision).toBe(saved.editRevision);

  // Turning goes through the four sides: from the nearest one (front) to right, back, left, front.
  const turn = page.getByRole('button', { name: '오른쪽 90°', exact: true });
  const seen: number[] = [];
  let previous = await quarterOf(page);
  for (let i = 0; i < 4; i++) {
    await turn.click();
    await expect.poll(() => quarterOf(page)).not.toBe(previous);
    previous = await quarterOf(page);
    seen.push(previous);
  }
  expect(seen.slice(0, 4).sort((a, b) => a - b)).toEqual([-90, 0, 90, 180]);
  expect(new Set(seen).size).toBe(4);
});
