// The AI input picture of a project from each view (front, right side, top), straight from the export
// dialog's "AI 입력 시점" preview (the same render, camera and photo choice the conversion sends). No AI call.
// Usage: node tests/product-representation/capture-views.mjs <label> <project id> [view ...]
import { mkdirSync } from 'node:fs';
import { session, BASE, ROOT } from './lib.mjs';
const [label, id, ...rest] = process.argv.slice(2);
const views = rest.length ? rest : ['정면', '오른쪽', '위에서'];
const TURNS = {
  정면: [],
  오른쪽: ['오른쪽으로 90° 돌리기'],
  왼쪽: ['왼쪽으로 90° 돌리기'],
  위에서: ['위에서 보기'],
  '오른쪽 위': ['오른쪽으로 90° 돌리기', '위에서 보기'],
};
mkdirSync(`${ROOT}/views`, { recursive: true });
const s = await session();
const { page } = s;
try {
  await page.goto(`${BASE}/projects/${id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await page.waitForTimeout(4000);
  const dialog = page.getByRole('dialog').last();
  for (const view of views) {
    await dialog.getByRole('button', { name: '정면으로', exact: true }).click();
    await page.waitForTimeout(1500);
    for (const t of TURNS[view]) {
      await dialog.getByRole('button', { name: t, exact: true }).click();
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500);
    const readout = await dialog
      .getByTestId('flux-view-readout')
      .innerText()
      .catch(() => '?');
    await dialog
      .locator('canvas')
      .first()
      .screenshot({ path: `${ROOT}/views/${label}-${view}.png` });
    console.log(label, view, 'readout:', readout);
  }
} finally {
  await s.close();
}
