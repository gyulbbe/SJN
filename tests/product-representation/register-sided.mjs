// Registers one toilet with FOUR directions (정면 = the bear toilet's cutout, 오른쪽·왼쪽·뒤 = make-sides.mjs
// drawings), as a plain flat-photo material, through the admin form.
// Usage: node tests/product-representation/register-sided.mjs
import { readFileSync } from 'node:fs';
import { session, BASE, ROOT } from './lib.mjs';
const boxes = JSON.parse(readFileSync(`${ROOT}/input/boxes.json`, 'utf8'));
const b = boxes['bear-toilet'];
const files = [
  [`${ROOT}/input/bear-toilet-cutout.png`, '정면', { x: b.center[0], y: b.bottom }],
  [`${ROOT}/input/sided-toilet-right.png`, '오른쪽', { x: 50, y: 100 }],
  [`${ROOT}/input/sided-toilet-back.png`, '뒤', { x: 50, y: 100 }],
  [`${ROOT}/input/sided-toilet-left.png`, '왼쪽', { x: 50, y: 100 }],
];
const s = await session();
const { page } = s;
try {
  await page.goto(`${BASE}/admin/materials`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('상품명').fill('방향별 시험 변기');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('370');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('660');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('640');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('floor');
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(files.map(([file]) => file));
  await page.waitForTimeout(2000);
  const xs = form.getByLabel('기준점 X');
  const ys = form.getByRole('spinbutton', { name: /^Y/ });
  for (const [i, [, name, point]] of files.entries()) {
    await form.getByLabel(`촬영 방향 ${i + 1}`, { exact: true }).selectOption(name);
    await xs.nth(i).fill(String(point.x));
    await ys.nth(i).fill(String(point.y));
  }
  await page.screenshot({ path: `${ROOT}/shots/register-sided.png` });
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await page.waitForTimeout(4000);
  console.log('dialogs after save:', await page.getByRole('dialog').count());
} finally {
  await s.close();
}
