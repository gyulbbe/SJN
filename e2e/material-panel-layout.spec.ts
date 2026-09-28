import { mkdirSync } from 'node:fs';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { test, expect, type Page } from '@playwright/test';

/**
 * The editor's left material library at screen sizes that stand for browser zoom and Windows
 * scaling (CSS px): every thumbnail keeps its shape and size, the name stays on one line, a long
 * list scrolls instead of squeezing its rows, the filter panel does not change that, and nothing
 * overflows sideways. PANEL_PHASE=before (or any other name) only measures and captures into
 * test-results/material-panel/<phase>/, for the before/after record.
 */
const phase = process.env.PANEL_PHASE ?? 'after';
const check = phase === 'after';
const shots = `test-results/material-panel/${phase}`;
mkdirSync(shots, { recursive: true });
/** The thumbnail's width ÷ height and smallest height (see .material-tile .swatch). */
const SWATCH_ASPECT = 4 / 3;
const SWATCH_MIN_HEIGHT = 72;
const sizes: [number, number][] = [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1097, 617],
  [2560, 1440],
  [390, 844],
];

let app: AuthenticatedApp | undefined;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

/** Eight tiles (both walls and floors) and seven products, some with long names. */
async function seedCatalog(page: Page) {
  await page.evaluate(async () => {
    const api = async (path: string, body: FormData | object) => {
      const response = await fetch(
        '/api/d1/' + path,
        body instanceof FormData
          ? { method: 'POST', body }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    const catalog = await api('catalog', { operation: 'list' });
    const option = (kind: string, name: string) =>
      catalog.options.find((row: { kind: string; name: string }) => row.kind === kind && row.name === name);
    const upload = async (canvas: HTMLCanvasElement, kind: 'texture' | 'product', name: string) => {
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/png'),
      );
      const id = crypto.randomUUID();
      const form = new FormData();
      form.set(
        'metadata',
        JSON.stringify({
          id,
          name,
          mime: 'image/png',
          size: blob.size,
          width: canvas.width,
          height: canvas.height,
          kind,
          createdAt: new Date().toISOString(),
        }),
      );
      form.set('file', blob, name);
      await api('assets', form);
      return id;
    };
    const tiles = [
      ['라이트 스톤', '#c9c7bc', 600, 600, '그레이', '무광'],
      ['웜 샌드', '#b9a992', 300, 600, '베이지', '무광'],
      ['차콜 스톤', '#525957', 600, 600, '차콜', '무광'],
      ['클라우드 화이트', '#e8e9e0', 300, 600, '화이트', '유광'],
      ['포르투갈 수입 테라조 대형 포세린 타일 그레이 에디션', '#8a8981', 600, 1200, '그레이', '무광'],
      ['아이보리 서브웨이', '#f4efe0', 75, 300, '아이보리', '유광'],
      ['베이지 트래버틴 룩', '#d4c2a2', 400, 800, '베이지', '무광'],
      ['헥사곤 모자이크 화이트', '#f3f3ef', 200, 230, '화이트', '유광'],
    ] as const;
    for (const [index, [name, color, width, height, colorName, finish]] of tiles.entries()) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = Math.round((256 * height) / width);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // A visible pattern, so a squashed or cropped thumbnail shows in the captures.
      ctx.strokeStyle = '#00000033';
      for (let x = 0; x < canvas.width; x += 32) ctx.strokeRect(x, 0, 32, canvas.height);
      ctx.fillStyle = '#0000004d';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText(String(index + 1), 12, 48);
      const assetId = await upload(canvas, 'texture', `${name}.png`);
      const colorOption = option('color', colorName),
        finishOption = option('finish', finish);
      await api('materials', {
        operation: 'create',
        input: {
          name,
          code: `QA-PANEL-T${index + 1}`,
          brand: '',
          category: 'tile',
          scope: 'shared',
          description: '패널 배치 검증용 직접 제작 질감',
          color: colorOption ? colorName : '',
          finish: finishOption ? finish : '',
          catalog: {
            colorIds: colorOption ? [colorOption.id] : [],
            compositionIds: [],
            finishIds: finishOption ? [finishOption.id] : [],
          },
          widthMm: width,
          heightMm: height,
          depthMm: 9,
          usage: 'both',
          installation: 'floor',
          coverAssetId: assetId,
          imageAssetIds: [],
          textureAssetIds: [assetId],
          views: [],
          defaultGroutWidth: 2,
          defaultGroutColor: '#d5d1c9',
          defaultPattern: 'grid',
        },
      });
    }
    const products = [
      ['벽걸이 세면대', 'basin', 500, 450, 420],
      ['탑볼 세면대 라운드', 'basin', 420, 180, 420],
      ['원피스 양변기', 'toilet', 380, 780, 700],
      ['투피스 절수형 양변기 스탠다드 화이트 대형 모델', 'toilet', 400, 800, 720],
      ['반다리 세면대', 'basin', 560, 830, 460],
      ['벽걸이 양변기', 'toilet', 360, 400, 540],
      ['사각 세면대', 'basin', 600, 160, 450],
    ] as const;
    for (const [index, [name, category, width, height, depth]] of products.entries()) {
      // Tall and wide product photos: contain must keep them whole.
      const canvas = document.createElement('canvas');
      canvas.width = width > height ? 300 : 180;
      canvas.height = width > height ? 160 : 300;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f1f0ec';
      ctx.strokeStyle = '#3d7a6a';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 18);
      ctx.fill();
      ctx.stroke();
      const assetId = await upload(canvas, 'product', `${name}.png`);
      await api('materials', {
        operation: 'create',
        input: {
          name,
          code: `QA-PANEL-P${index + 1}`,
          brand: '',
          category,
          scope: 'shared',
          description: '패널 배치 검증용 직접 제작 이미지',
          color: '',
          finish: '',
          catalog: { colorIds: [], compositionIds: [], finishIds: [] },
          widthMm: width,
          heightMm: height,
          depthMm: depth,
          usage: 'both',
          installation: 'floor',
          coverAssetId: assetId,
          imageAssetIds: [assetId],
          textureAssetIds: [],
          views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.98 } }],
          defaultGroutWidth: 2,
          defaultGroutColor: '#dddddd',
          defaultPattern: 'grid',
        },
      });
    }
  });
}

type Measure = {
  panel: { width: number; height: number; scrollWidth: number; clientWidth: number };
  grid: { top: number; height: number; clientHeight: number; scrollHeight: number };
  tiles: {
    swatch: { width: number; height: number };
    top: number;
    bottom: number;
    image: { fit: string };
    name: { height: number; visible: boolean; lineHeight: number; fontSize: number };
    size: { fontSize: number };
    height: number;
    visible: boolean;
  }[];
  controls: { height: number; smallestFont: number; smallestTarget: number };
  pageOverflow: boolean;
  /** The second row of cards ends inside the panel's visible part without scrolling the panel. */
  twoRowsInView: boolean;
  panelScroll: number;
};
/** Sizes of the panel, the list and each thumbnail, as the user sees them. */
const measure = (page: Page) =>
  page.evaluate((): Measure => {
    const panel = document.querySelector<HTMLElement>('aside.catalog-panel')!;
    const grid = panel.querySelector<HTMLElement>('.catalog-grid')!;
    const box = grid.getBoundingClientRect();
    const tiles = [...grid.querySelectorAll<HTMLElement>('.material-tile')].map((tile) => {
      const rect = tile.getBoundingClientRect();
      const box = tile.querySelector<HTMLElement>('.swatch')!.getBoundingClientRect();
      // What shows of it: the card clips its content.
      const swatch = { width: box.width, height: Math.max(0, Math.min(box.bottom, rect.bottom) - box.top) };
      const name = tile.querySelector<HTMLElement>('strong')!;
      const nameRect = name.getBoundingClientRect();
      const style = getComputedStyle(name);
      const image = tile.querySelector('img');
      return {
        swatch,
        top: rect.top,
        bottom: rect.bottom,
        image: { fit: image ? getComputedStyle(image).objectFit : 'none' },
        name: {
          height: nameRect.height,
          // Inside its card, not clipped by it.
          visible: nameRect.height > 0 && nameRect.bottom <= rect.bottom + 0.5 && nameRect.top >= rect.top,
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
          fontSize: parseFloat(style.fontSize),
        },
        size: { fontSize: parseFloat(getComputedStyle(tile.querySelector('small')!).fontSize) },
        height: rect.height,
        // Wholly inside the list's visible part.
        visible: rect.top >= box.top - 0.5 && rect.bottom <= box.top + grid.clientHeight + 0.5,
      };
    });
    const controls = [...panel.querySelectorAll<HTMLElement>('button, select, input, label')].filter(
      (element) => !grid.contains(element) && element.getClientRects().length > 0,
    );
    const texts = [...panel.querySelectorAll<HTMLElement>('*')].filter(
      (element) =>
        !grid.contains(element) &&
        element.getClientRects().length > 0 &&
        [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim()),
    );
    const panelBox = panel.getBoundingClientRect();
    const rowTops = [...new Set(tiles.map((tile) => Math.round(tile.top)))].sort((a, b) => a - b);
    const secondRow = tiles.filter((tile) => Math.round(tile.top) === rowTops[1]);
    const footer = panel.querySelector<HTMLElement>('.catalog-footer');
    const visibleBottom = Math.min(
      panelBox.top + panel.clientHeight,
      footer && panel.scrollHeight <= panel.clientHeight ? footer.getBoundingClientRect().top : Infinity,
      window.innerHeight,
    );
    return {
      twoRowsInView:
        panel.scrollTop === 0 &&
        secondRow.length > 0 &&
        Math.max(...secondRow.map((t) => t.bottom)) <= visibleBottom + 0.5,
      panelScroll: panel.scrollHeight - panel.clientHeight,
      panel: {
        width: panelBox.width,
        height: panelBox.height,
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
      },
      grid: {
        top: box.top - panelBox.top,
        height: box.height,
        clientHeight: grid.clientHeight,
        scrollHeight: grid.scrollHeight,
      },
      tiles,
      controls: {
        height: box.top - panelBox.top,
        smallestFont: Math.min(...texts.map((element) => parseFloat(getComputedStyle(element).fontSize))),
        smallestTarget: Math.min(
          ...controls
            .filter((element) => element.matches('button, select, input'))
            // A text field's target is its whole box (the search box around the bare input).
            .map((element) => (element.matches('input') ? (element.closest('label') ?? element) : element))
            .map((element) => element.getBoundingClientRect().height),
        ),
      },
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

test('material library thumbnails keep their shape at every screen size; the list scrolls', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedCatalog(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  const report: Record<string, unknown>[] = [];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const drawer = width <= 1100;
    if (drawer && !(await panel.isVisible())) {
      await page.getByRole('button', { name: '자재 목록', exact: true }).click();
      await expect(panel).toBeVisible();
    }
    for (const [tab, label] of [
      ['wall', '벽 타일'],
      ['floor', '바닥 타일'],
      ['fixtures', '위생도기'],
    ] as const) {
      await panel.getByRole('button', { name: label, exact: true }).click();
      await expect(panel.locator('.material-tile')).toHaveCount(tab === 'fixtures' ? 7 : 8);
      await expect(panel.locator('.material-tile img').first()).toBeVisible();
      await page.waitForTimeout(150);
      for (const filter of tab === 'fixtures' ? [false] : [false, true]) {
        const toggle = panel.getByRole('button', { name: '사이즈', exact: true });
        if (filter) await toggle.click();
        const m = await measure(page);
        const name = `${width}x${height}-${tab}${filter ? '-filter' : ''}`;
        await page.screenshot({ path: `${shots}/${name}.png` });
        const first = m.tiles[0];
        const row = {
          name,
          panel: Math.round(m.panel.width),
          controls: Math.round(m.controls.height),
          grid: `${m.grid.clientHeight}/${m.grid.scrollHeight}`,
          swatch: `${Math.round(first.swatch.width)}x${Math.round(first.swatch.height)}`,
          nameVisible: m.tiles.filter((t) => t.name.visible).length + '/' + m.tiles.length,
          smallestFont: m.controls.smallestFont,
          smallestTarget: Math.round(m.controls.smallestTarget),
          twoRowsInView: m.twoRowsInView,
          panelScroll: m.panelScroll,
        };
        report.push(row);
        console.log(JSON.stringify(row));
        if (check) {
          for (const tile of m.tiles) {
            expect(tile.swatch.height, `${name}: thumbnail height`).toBeGreaterThanOrEqual(SWATCH_MIN_HEIGHT);
            expect(tile.swatch.width / tile.swatch.height, `${name}: thumbnail shape`).toBeCloseTo(
              SWATCH_ASPECT,
              1,
            );
            expect(tile.name.visible, `${name}: name inside its card`).toBe(true);
            expect(tile.name.height, `${name}: one line of name`).toBeLessThan(tile.name.lineHeight * 1.5);
            expect(tile.name.fontSize).toBeGreaterThanOrEqual(11);
            expect(tile.size.fontSize).toBeGreaterThanOrEqual(11);
            expect(tile.image.fit).toBe(tab === 'fixtures' ? 'contain' : 'cover');
          }
          // Every card keeps its full height; a long list scrolls.
          const tallest = Math.max(...m.tiles.map((t) => t.height));
          expect(Math.min(...m.tiles.map((t) => t.height))).toBeGreaterThan(tallest - 1);
          const columns = Math.round(m.panel.width / (m.tiles[0].swatch.width + 8));
          const rows = Math.ceil(m.tiles.length / Math.max(1, columns));
          if (m.grid.clientHeight < rows * tallest)
            expect(m.grid.scrollHeight).toBeGreaterThan(m.grid.clientHeight);
          // At least two rows of thumbnails in view with the filters closed.
          expect(m.grid.clientHeight, `${name}: two rows in the list`).toBeGreaterThanOrEqual(2 * tallest);
          if (!filter) expect(m.twoRowsInView, `${name}: two rows in view`).toBe(true);
          expect(m.controls.smallestFont, `${name}: text size`).toBeGreaterThanOrEqual(11);
          expect(m.controls.smallestTarget, `${name}: target size`).toBeGreaterThanOrEqual(
            width <= 620 ? 44 : 32,
          );
          expect(m.panel.scrollWidth, `${name}: panel overflow`).toBeLessThanOrEqual(m.panel.clientWidth);
          expect(m.pageOverflow, `${name}: page overflow`).toBe(false);
        }
        if (filter) await toggle.click();
      }
    }
  }
  testInfo.annotations.push({ type: 'panel', description: JSON.stringify(report) });
  expect(errors).toEqual([]);
});
