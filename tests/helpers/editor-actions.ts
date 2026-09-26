import { expect, type Page } from '@playwright/test';
import type { FixtureInstance, ProjectDocument, Surface } from '../../src/lib/types';

/** Inspect the persisted result; mutations still use the visible editor controls. */
export async function storedProject(page: Page): Promise<ProjectDocument> {
  return page.evaluate(async (id) => {
    const response = await fetch('/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'load', id }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, page.url().split('/').at(-1)!);
}

export async function savedProject(page: Page, afterRevision?: number) {
  if (afterRevision !== undefined)
    await expect.poll(async () => (await storedProject(page)).editRevision).toBeGreaterThan(afterRevision);
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
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

/**
 * A top-bar editor action (공간 둘러보기, 공간 크기, 내보내기, …). Below 1280px wide these sit in the
 * 더보기 menu: it is opened when the button is not already on screen. Clicking an action in the
 * menu closes it; after only looking at one, call closeEditorActions.
 */
export async function editorAction(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) {
    await page.getByRole('button', { name: '더보기', exact: true }).click();
    await expect(button).toBeVisible();
  }
  return button;
}

export async function closeEditorActions(page: Page) {
  const more = page.getByRole('button', { name: '더보기', exact: true });
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  }
}
