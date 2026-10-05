// Builds the R1 study room through the editor UI: the default room (2400 x 2400 x 2400 mm), grey wall
// tiles, light floor tiles, and the four flat-photo products at explicit places.
// Usage: node tests/product-representation/build-project.mjs [name]
import { readFileSync } from 'node:fs';
import { session, BASE, ROOT, d1 } from './lib.mjs';
const label = process.argv[2] ?? 'R1';
// --model: switch every product to its standard model right after placing it ("표준 모형으로 보기").
const model = process.argv.includes('--model');
// --roundtrip: switch each product on and then off again (the photo must come back exactly).
const roundtrip = process.argv.includes('--roundtrip');
// --items file.json: another set of products [{ name, face, u, v, angle? }] (angle: the photo to use, e.g. '오른쪽').
const itemsFile = process.argv.indexOf('--items');
const items =
  itemsFile > 0
    ? JSON.parse(readFileSync(process.argv[itemsFile + 1], 'utf8'))
    : [
        { name: '평면 사각 욕조', face: '바닥', u: 50, v: 20 },
        { name: '평면 곰 변기', face: '바닥', u: 28, v: 66 },
        { name: '평면 스마트 변기', face: '바닥', u: 72, v: 66 },
        { name: '평면 벽걸이 세면대', face: '왼쪽 벽', u: 50, v: 55 },
      ];
const s = await session();
const { page } = s;
const shot = (n) => page.screenshot({ path: `${ROOT}/shots/${label}-${n}.png` });
try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page
    .getByRole('button', { name: /기본 공간으로 시작/ })
    .first()
    .click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await page.waitForURL(/\/projects\//, { timeout: 30000 });
  await page.waitForTimeout(5000);
  const url = page.url();
  console.log('PROJECT', url);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.getByText('그레이 벽 타일', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.getByText('라이트 바닥 타일', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  for (const it of items) {
    await page.getByText(it.name, { exact: true }).first().click();
    await page.waitForTimeout(3000);
    if (it.face !== '바닥') {
      await page.getByLabel('제품 설치 면', { exact: true }).selectOption({ label: it.face });
      await page.waitForTimeout(1500);
    }
    if (it.angle) {
      await page.getByLabel(`${it.angle} 각도 선택`, { exact: true }).click();
      await page.waitForTimeout(1500);
    }
    for (const [labs, val] of [
      [['면 가로 위치 (%)'], it.u],
      [['면 깊이 위치 (%)', '면 세로 위치 (%)'], it.v],
    ]) {
      let input;
      for (const lab of labs) {
        const c = page.getByLabel(lab, { exact: true });
        if (await c.count()) {
          input = c.last();
          break;
        }
      }
      if (!input) {
        console.log('no field for', labs);
        continue;
      }
      await input.fill(String(val));
      await input.blur();
      await page.waitForTimeout(800);
    }
    if (model || roundtrip) {
      const toggle = page.getByRole('switch', { name: '표준 모형으로 보기' });
      await toggle.click();
      await page.getByTestId('standard-model-notice').waitFor();
      await page.waitForTimeout(1200);
      if (roundtrip) {
        await toggle.click();
        await page.waitForTimeout(1500);
      }
    }
    const notice = await page
      .getByTestId('auto-detection-notice')
      .innerText()
      .catch(() => '');
    const info = await page
      .getByTestId('facing-info')
      .innerText()
      .catch(() => '');
    const warn = await page.getByTestId('facing-warning').count();
    console.log(
      'placed',
      it.name,
      '| notice:',
      notice.replace(/\n/g, ' '),
      '| info:',
      info.replace(/\n/g, ' '),
      '| warning:',
      warn,
    );
    await shot('20-' + it.name.replace(/\s/g, '_'));
  }
  await page.mouse.click(300, 160);
  await page.waitForTimeout(1500);
  await shot('21-final');
  await page
    .getByRole('button', { name: '지금 저장', exact: true })
    .click()
    .catch(() => {});
  await page.waitForTimeout(4000);
  const id = url.match(/projects\/([^/?#]+)/)?.[1];
  const doc = (await d1('projects', { operation: 'load', id })).json;
  const design = doc.designs?.find((d) => d.id === doc.activeDesignId) ?? doc.designs?.[0];
  const scene = design.scene;
  console.log('room', JSON.stringify(scene.room));
  for (const f of scene.fixtures)
    console.log(
      'fixture',
      f.name,
      JSON.stringify({
        face: f.roomPlacement.face,
        u: +f.roomPlacement.u.toFixed(3),
        v: +f.roomPlacement.v.toFixed(3),
        viewIndex: f.viewIndex,
        scale: f.roomPlacement.scale,
        w: f.roomPlacement.widthMm,
        h: f.roomPlacement.heightMm,
      }),
    );
  console.log('PROJECT_ID', id);
} finally {
  await s.close();
}
