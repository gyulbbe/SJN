import { test, expect, type Page } from '@playwright/test';
import { getActiveDesign } from '../src/lib/designs';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';

let app: AuthenticatedApp;

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
});
test.afterEach(async () => {
  await app?.dispose();
});

const undo = (page: Page) => page.getByRole('button', { name: '실행 취소', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '다시 실행', exact: true });
const exposure = (page: Page) => page.getByRole('slider', { name: '노출', exact: true });

async function createRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(exposure(page)).toHaveValue('0');
}

async function savedDesign(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  return getActiveDesign(await app.project())!;
}

async function changeExposure(page: Page) {
  await exposure(page).focus();
  await exposure(page).press('ArrowRight');
  await exposure(page).blur();
  await expect(exposure(page)).toHaveValue('0.01');
  await expect(undo(page)).toBeEnabled();
}

async function projectShortcut(page: Page, shortcut: string) {
  // Focus a non-input element without clicking: the shortcut must own the history action.
  await page.getByRole('button', { name: '지금 저장', exact: true }).focus();
  await page.keyboard.press(shortcut);
}

test('Ctrl+Z·Ctrl+Y·Ctrl+Shift+Z와 버튼이 같은 이력을 되돌리고 저장한다', async ({ page }, testInfo) => {
  await createRoom(page);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
  await expect(undo(page)).toHaveAttribute('title', /Ctrl\+Z/);
  await expect(redo(page)).toHaveAttribute('title', /Ctrl\+Y/);
  await expect(undo(page)).toHaveAttribute('aria-keyshortcuts', /Control\+Z/i);
  await expect(redo(page)).toHaveAttribute('aria-keyshortcuts', /Control\+Y/i);
  await changeExposure(page);
  const changed = await savedDesign(page);
  expect(changed.history.past).toHaveLength(1);
  await expect(redo(page)).toBeDisabled();

  await projectShortcut(page, 'Control+z');
  await expect(exposure(page)).toHaveValue('0');
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeEnabled();
  await projectShortcut(page, 'Control+y');
  await expect(exposure(page)).toHaveValue('0.01');
  await expect(redo(page)).toBeDisabled();
  await projectShortcut(page, 'Control+z');
  await projectShortcut(page, 'Control+Shift+z');
  await expect(exposure(page)).toHaveValue('0.01');

  await undo(page).click();
  await expect(exposure(page)).toHaveValue('0');
  await redo(page).click();
  await expect(exposure(page)).toHaveValue('0.01');
  expect((await savedDesign(page)).scene.color).toEqual(changed.scene.color);
  await redo(page).hover({ force: true });
  await page.screenshot({ path: testInfo.outputPath('project-history-controls.png'), fullPage: true });

  await page.reload();
  await expect(exposure(page)).toHaveValue('0.01', { timeout: 30000 });
  await projectShortcut(page, 'Control+z');
  await expect(exposure(page)).toHaveValue('0');
  await exposure(page).press('ArrowLeft');
  await exposure(page).blur();
  await expect(exposure(page)).toHaveValue('-0.01');
  await expect(redo(page)).toBeDisabled();
  await projectShortcut(page, 'Control+y');
  await expect(exposure(page)).toHaveValue('-0.01');
  expect((await savedDesign(page)).history.future).toHaveLength(0);
});

test('프로젝트명과 숫자 입력 중에는 브라우저 입력 실행 취소를 보존한다', async ({ page }) => {
  await createRoom(page);
  await changeExposure(page);
  const before = await savedDesign(page);
  const title = page.getByRole('textbox', { name: '프로젝트명', exact: true });
  const originalTitle = await title.inputValue();
  await title.focus();
  await title.press('End');
  await title.pressSequentially(' EDIT');
  await expect(title).toHaveValue(originalTitle + ' EDIT');
  await title.press('Control+z');
  await expect(title).toHaveValue(originalTitle);
  await expect(exposure(page)).toHaveValue('0.01');
  await title.press('Control+y');
  await expect(title).toHaveValue(originalTitle + ' EDIT');
  await expect(exposure(page)).toHaveValue('0.01');
  await title.blur();

  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  const width = dialog.getByLabel('가로 (m)', { exact: true });
  await width.focus();
  await width.press('Control+a');
  await width.pressSequentially('3.6');
  await expect(width).toHaveValue('3.6');
  await width.press('Control+z');
  await expect(width).toHaveValue('2.4');
  await expect(exposure(page)).toHaveValue('0.01');
  await width.press('Control+y');
  await expect(width).toHaveValue('3.6');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  const after = await savedDesign(page);
  expect(after.scene).toEqual(before.scene);
  expect(after.history).toEqual(before.history);
});

test('내보내기·도움말 팝업 안 단축키가 뒤의 프로젝트를 바꾸지 않는다', async ({ page }) => {
  await createRoom(page);
  await changeExposure(page);
  const before = await savedDesign(page);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
  await exportDialog.getByRole('button', { name: '닫기', exact: true }).focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+Shift+z');
  await expect(exposure(page)).toHaveValue('0.01');
  expect((await savedDesign(page)).history).toEqual(before.history);
  await exportDialog.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByTitle('사용 도움말', { exact: true }).click();
  const help = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: '공간미리 사용 안내', exact: true }) });
  await help.locator('button').first().focus();
  await page.keyboard.press('Control+z');
  await expect(exposure(page)).toHaveValue('0.01');
  expect((await savedDesign(page)).history).toEqual(before.history);
  await help.locator('button').first().click();
  await projectShortcut(page, 'Control+z');
  await expect(exposure(page)).toHaveValue('0');
  await expect(redo(page)).toBeEnabled();
});

test('한글 키 배열의 물리 키를 지원하고 IME 조합·소비된 이벤트·Alt 조합을 무시한다', async ({ page }) => {
  await createRoom(page);
  await changeExposure(page);
  const before = await savedDesign(page);
  const target = page.getByRole('button', { name: '지금 저장', exact: true });
  type ShortcutEvent = Pick<
    KeyboardEventInit,
    'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'
  >;
  const dispatch = (options: ShortcutEvent, consumed = false) =>
    target.evaluate(
      (element, { options, consumed }) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
        if (consumed) event.preventDefault();
        element.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { options, consumed },
    );

  for (const protection of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }]) {
    expect(await dispatch({ key: 'z', code: 'KeyZ', ctrlKey: true, ...protection })).toBe(false);
    await expect(exposure(page)).toHaveValue('0.01');
  }
  expect(await dispatch({ key: 'z', code: 'KeyZ', ctrlKey: true }, true)).toBe(true);
  await expect(exposure(page)).toHaveValue('0.01');
  expect((await savedDesign(page)).history).toEqual(before.history);

  expect(await dispatch({ key: 'ㅋ', code: 'KeyZ', ctrlKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0');
  expect(await dispatch({ key: 'ㅛ', code: 'KeyY', ctrlKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0.01');
  // Letter keys win over their physical positions on alternate Latin keyboard layouts.
  expect(await dispatch({ key: 'z', code: 'KeyY', ctrlKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0');
  expect(await dispatch({ key: 'y', code: 'KeyZ', ctrlKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0.01');
  expect(await dispatch({ key: 'z', code: 'KeyZ', metaKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0');
  expect(await dispatch({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })).toBe(true);
  await expect(exposure(page)).toHaveValue('0.01');
  expect((await savedDesign(page)).scene.color).toEqual(before.scene.color);
});
