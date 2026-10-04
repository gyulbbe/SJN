// Registers the four study products as plain flat-photo materials (no 360°): a 정면 photo (the
// background-removed original) plus one more direction (the same cutout mirrored), through the admin form.
// Usage: node tests/product-representation/register-products.mjs [key ...] [--probe]
import { readFileSync } from 'node:fs';
import { session, BASE, ROOT } from './lib.mjs';
const products = JSON.parse(readFileSync('tests/product-representation/products.json', 'utf8'));
const keys = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const probe = process.argv.includes('--probe');
// --single: the product with only its 정면 photo (what a user who has one photo registers).
const single = process.argv.includes('--single');
const boxes = JSON.parse(readFileSync(`${ROOT}/input/boxes.json`, 'utf8'));
const s = await session();
const { page } = s;
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/.test(m.text())) console.log('CONSOLE-ERR', m.text().slice(0, 200));
});
try {
  for (const key of keys.length ? keys : Object.keys(products)) {
    const p = products[key];
    await page.goto(`${BASE}/admin/materials`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '자재 등록', exact: true }).click();
    const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
    await form.getByLabel('카테고리', { exact: true }).selectOption(p.category);
    await form.getByLabel('상품명').fill(single ? p.name.replace('평면 ', '정면만 ') : p.name);
    await form.getByLabel('가로 (mm)', { exact: true }).fill(String(p.width));
    await form.getByLabel('높이 (mm)', { exact: true }).fill(String(p.height));
    await form.getByLabel('깊이 (mm)', { exact: true }).fill(String(p.depth));
    await form.getByLabel('설치 방식', { exact: true }).selectOption(p.install);
    await form
      .getByLabel('+ 제품 이미지 올리기', { exact: true })
      .setInputFiles(
        single
          ? [`${ROOT}/input/${key}-cutout.png`]
          : [`${ROOT}/input/${key}-cutout.png`, `${ROOT}/input/${key}-cutout-mirrored.png`],
      );
    await page.waitForTimeout(1500);
    await form.getByLabel('촬영 방향 1', { exact: true }).selectOption('정면');
    if (!single) await form.getByLabel('촬영 방향 2', { exact: true }).selectOption(p.second);
    const b = boxes[key];
    // The reference point: bottom centre for a floor product, the middle of the content for a wall one.
    const point =
      p.install === 'floor' ? { x: b.center[0], y: b.bottom } : { x: b.center[0], y: b.center[1] };
    const mirrored = { x: String(100 - Number(point.x)), y: point.y };
    const xs = form.getByLabel('기준점 X');
    const ys = form.getByRole('spinbutton', { name: /^Y/ });
    console.log(
      key,
      'anchor inputs',
      await xs.count(),
      await ys.count(),
      'defaults',
      await xs.nth(0).inputValue(),
      await ys.nth(0).inputValue(),
    );
    if (!probe) {
      await xs.nth(0).fill(String(point.x));
      await ys.nth(0).fill(String(point.y));
      if (!single) {
        await xs.nth(1).fill(mirrored.x);
        await ys.nth(1).fill(String(mirrored.y));
      }
    }
    await page.screenshot({ path: `${ROOT}/shots/register-${key}.png` });
    if (probe) {
      await page.keyboard.press('Escape');
      continue;
    }
    await form.getByRole('button', { name: '자재 등록', exact: true }).click();
    await page.waitForTimeout(4000);
    console.log(key, 'dialogs after save:', await page.getByRole('dialog').count());
  }
} finally {
  await s.close();
}
