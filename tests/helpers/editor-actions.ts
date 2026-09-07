import { expect, type Page } from '@playwright/test';
import type { FixtureInstance, ProjectDocument, Surface } from '../../src/lib/types';

/** Inspect the persisted result; mutations still use the visible editor controls. */
export async function storedProject(page: Page): Promise<ProjectDocument> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<ProjectDocument>((resolve, reject) => {
        const request = database.transaction('projects').objectStore('projects').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, page.url().split('/').at(-1)!);
}

export async function savedProject(page: Page, afterRevision?: number) {
  if (afterRevision !== undefined)
    await expect.poll(async () => (await storedProject(page)).editRevision).toBeGreaterThan(afterRevision);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  return storedProject(page);
}

/** Surface selection uses the material placement control, without a layer list or geometry handles. */
export async function selectSurface(page: Page, surface: Pick<Surface, 'id' | 'kind'>) {
  await page
    .getByRole('button', { name: surface.kind === 'wall' ? '벽 타일' : '바닥 타일', exact: true })
    .click();
  const location = page.getByLabel('타일 적용 위치', { exact: true });
  await location.selectOption(surface.id);
  await location.blur();
  await expect(page.getByRole('heading', { name: '타일 속성', exact: true })).toBeVisible();
}

/** Both ordinary image rectangles and perspective product polygons carry the same hit target. */
export async function selectFixture(page: Page, fixture: Pick<FixtureInstance, 'id'>) {
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  await page.locator(`[data-testid="editor-canvas"] [data-entity="${fixture.id}"]`).click();
  await expect(page.getByRole('heading', { name: '제품 속성', exact: true })).toBeVisible();
}
