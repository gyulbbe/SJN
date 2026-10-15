import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page, type Request as PlaywrightRequest } from '@playwright/test';
import sharp from 'sharp';

let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

// "AI로 방향 사진 만들기" in the material form. The model is a mock: it paints the guide's product
// (whatever is not plain white) a colour per direction — 정면 red, 왼쪽 blue with a yellow band on the
// side the product's front points to (the picture's left), 뒤 green — at twice the guide's size. The
// cut-out model is a double too (whatever is not plain white is the product). No real AI runs.

const RED = '#e02020',
  BLUE = '#2030e0',
  YELLOW = '#e0d020',
  GREEN = '#20b040';
const hex = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

async function installCutoutDouble(page: Page) {
  await page.addInitScript(() => {
    class Double extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      private send(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data }));
      }
      postMessage(message: { id: number; blob?: Blob }) {
        void (async () => {
          this.send({
            type: 'progress',
            id: message.id,
            progress: { stage: 'processing', message: '검증용 배경 제거' },
          });
          const bitmap = await createImageBitmap(message.blob!);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
          for (let i = 0; i < image.data.length; i += 4)
            if (image.data[i] > 250 && image.data[i + 1] > 250 && image.data[i + 2] > 250)
              image.data[i + 3] = 0;
          context.putImageData(image, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          this.send({
            type: 'result',
            id: message.id,
            result: {
              blob,
              width: bitmap.width,
              height: bitmap.height,
              analysisWidth: 512,
              analysisHeight: 512,
              backend: 'wasm',
              precision: 'fp32',
              downloadMs: 0,
              initializationMs: 0,
              processingMs: 1,
              inferenceMs: 1,
              cacheSource: 'memory',
            },
          });
        })();
      }
      terminate() {}
    }
    (window as unknown as { Worker: unknown }).Worker = Double;
  });
}

/** The mock model's answer: the guide's product painted for its direction, twice as large. */
async function paint(guide: Buffer, direction: string) {
  const { data, info } = await sharp(guide).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const white = (i: number) => data[i * 3] >= 254 && data[i * 3 + 1] >= 254 && data[i * 3 + 2] >= 254;
  let left = width,
    right = -1;
  for (let i = 0; i < width * height; i++)
    if (!white(i)) {
      left = Math.min(left, i % width);
      right = Math.max(right, i % width);
    }
  const out = Buffer.alloc(width * height * 3, 255);
  for (let i = 0; i < width * height; i++) {
    if (white(i)) continue;
    const x = i % width;
    const colour =
      direction === 'front'
        ? RED
        : direction === 'back'
          ? GREEN
          : x < left + (right - left) * 0.3
            ? YELLOW
            : BLUE;
    out.set(hex(colour), i * 3);
  }
  return sharp(out, { raw: { width, height, channels: 3 } })
    .resize(width * 2, height * 2, { kernel: 'nearest' })
    .png()
    .toBuffer();
}
async function formOf(request: PlaywrightRequest) {
  return new Response(new Uint8Array(request.postDataBuffer()!), {
    headers: { 'content-type': request.headers()['content-type'] },
  }).formData();
}
type Sent = {
  keys: string[];
  seed: string;
  spec: Record<string, unknown>;
  guide: [number, number];
  refs: number[][];
};
async function mockModel(
  page: Page,
  sent: Sent[],
  answer?: (spec: Record<string, unknown>) => Promise<unknown>,
) {
  await page.route('**/api/materials/direction-photo', async (route) => {
    const form = await formOf(route.request());
    const spec = JSON.parse(String(form.get('spec')));
    const guide = Buffer.from(await (form.get('guide') as Blob).arrayBuffer());
    const meta = await sharp(guide).metadata();
    const refs = await Promise.all(
      form.getAll('refs').map(async (ref) => {
        const m = await sharp(Buffer.from(await (ref as Blob).arrayBuffer())).metadata();
        return [m.width!, m.height!];
      }),
    );
    sent.push({
      keys: [...form.keys()],
      seed: String(form.get('seed')),
      spec,
      guide: [meta.width!, meta.height!],
      refs,
    });
    const custom = await answer?.(spec);
    if (custom) return route.fulfill(custom as Parameters<typeof route.fulfill>[0]);
    await route.fulfill({ contentType: 'image/png', body: await paint(guide, spec.direction) });
  });
}
/** A grey tub on white, as a catalogue photo from above at an angle. */
const tubPhoto = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#fff"/><ellipse cx="320" cy="190" rx="250" ry="110" fill="#d9d9d9"/><ellipse cx="320" cy="175" rx="215" ry="80" fill="#efefef"/><rect x="90" y="190" width="460" height="120" rx="60" fill="#cfcfcf"/></svg>',
    ),
  )
    .png()
    .toBuffer();

async function openGenerator(
  form: Locator,
  sizes: [string, string, string],
  category = 'bath',
  installation = 'floor',
) {
  await form.getByLabel('카테고리', { exact: true }).selectOption(category);
  await form.getByLabel('가로 (mm)', { exact: true }).fill(sizes[0]);
  await form.getByLabel('높이 (mm)', { exact: true }).fill(sizes[1]);
  await form.getByLabel('깊이 (mm)', { exact: true }).fill(sizes[2]);
  await form.getByLabel('설치 방식', { exact: true }).selectOption(installation);
  const generator = form.getByTestId('ai-direction-photos');
  await generator.getByText('AI로 방향 사진 만들기', { exact: true }).click();
  return generator;
}
async function addReference(generator: Locator) {
  await generator
    .getByLabel('+ 참고 사진 올리기(1~3장)', { exact: true })
    .setInputFiles({ name: 'tub.png', mimeType: 'image/png', buffer: await tubPhoto() });
  await expect(generator.getByRole('img', { name: '참고 사진 1(배경 지움)', exact: true })).toBeVisible();
}

/** Red, blue, yellow and green pixels of a picture, and where the yellow and the blue ones sit. */
async function colours(image: Buffer) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const count = { red: 0, blue: 0, yellow: 0, green: 0, yellowX: 0, blueX: 0 };
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const x = (i / info.channels) % info.width;
    if (r > 170 && g < 90 && b < 90) count.red++;
    if (b > 170 && r < 90 && g < 90) {
      count.blue++;
      count.blueX += x;
    }
    if (r > 170 && g > 160 && b < 90) {
      count.yellow++;
      count.yellowX += x;
    }
    if (g > 140 && r < 90 && b < 120) count.green++;
  }
  return { ...count, yellowX: count.yellowX / (count.yellow || 1), blueX: count.blueX / (count.blue || 1) };
}

test('사진을 올리면 가이드 4장·후보를 만들고, 고른 사진이 방향 칸에 들어가 방의 네 방향에서 보인다', async ({
  page,
}, info) => {
  app = await authenticatedApp(page);
  await installCutoutDouble(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent: Sent[] = [];
  await mockModel(page, sent);
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('AI 방향 욕조');
  const generator = await openGenerator(form, ['1700', '560', '750']);

  // Four guides in one row; 오른쪽 comes from 왼쪽 turned over; the share the room draws them at.
  const guides = generator.getByTestId('ai-guides');
  await expect(guides.getByRole('img')).toHaveCount(4, { timeout: 30000 });
  await expect(guides).toContainText('오른쪽 · 왼쪽 사진을 좌우 반전해 써요');
  await expect(guides).toContainText('정면 · 후보 2장을 만들어요 · 방 화면에서 약 16% 작게 보여요');
  await expect(guides).toContainText('왼쪽 · 후보 2장을 만들어요 · 방 화면에서 약 33% 작게 보여요');
  await expect(generator.getByRole('button', { name: '방향 사진 만들기', exact: true })).toBeDisabled();
  await addReference(generator);
  // A bath's photos are not asked where they were taken from (only a toilet shaped like the product).
  await expect(generator.getByLabel('참고 사진 1 찍은 각도', { exact: true })).toHaveCount(0);
  await expect(generator.getByTestId('ai-estimate')).toContainText('AI 요청 6회');
  await generator.screenshot({ path: info.outputPath('generator-guides.png') });

  await generator.getByRole('button', { name: '방향 사진 만들기', exact: true }).click();
  for (const direction of ['정면', '왼쪽', '뒤'])
    await expect(
      generator.getByRole('group', { name: `${direction} 후보` }).getByRole('button', { name: /후보 \d$/ }),
    ).toHaveCount(2, { timeout: 30000 });
  await expect(generator.getByRole('group', { name: '오른쪽 후보' })).toHaveCount(0);
  // Six requests: two a direction, each its own seed; the guide, one photo, the seed and the facts only.
  expect(sent).toHaveLength(6);
  expect(sent.map((s) => s.spec.direction).sort()).toEqual([
    'back',
    'back',
    'front',
    'front',
    'left',
    'left',
  ]);
  expect(new Set(sent.map((s) => s.seed)).size).toBe(6);
  for (const s of sent) {
    expect(s.keys).toEqual(['guide', 'refs', 'seed', 'spec']);
    expect(s.spec).toEqual({
      category: 'bath',
      form: 'oval-freestanding',
      direction: s.spec.direction,
      installation: 'floor',
      sizeMm: [1700, 560, 750],
    });
    expect(s.guide).toEqual(s.spec.direction === 'left' ? [448, 496] : [496, 192]);
    for (const [w, h] of s.refs) {
      expect(Math.max(w, h)).toBeLessThanOrEqual(496);
      expect((w % 16) + (h % 16)).toBe(0);
    }
  }

  await generator.getByRole('button', { name: '정면 후보 2', exact: true }).click();
  await generator.getByRole('button', { name: '왼쪽 후보 1', exact: true }).click();
  await generator.getByRole('button', { name: '뒤 후보 1', exact: true }).click();
  await expect(generator.getByRole('button', { name: '정면 후보 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await generator.getByRole('button', { name: '고른 사진 넣기', exact: true }).click();
  await expect(generator.getByTestId('ai-notice')).toContainText('정면·왼쪽·오른쪽·뒤 칸에 넣었어요.');
  for (const [index, direction] of ['정면', '왼쪽', '오른쪽', '뒤'].entries())
    await expect(form.getByLabel(`촬영 방향 ${index + 1}`, { exact: true })).toHaveValue(direction);
  // The anchor sits on the product's outline: the middle of its bottom edge (a floor product).
  const x = form.getByLabel(/기준점 X/).first(),
    y = form.getByRole('spinbutton').nth(1);
  expect(Math.abs(Number(await x.inputValue()) - 50)).toBeLessThanOrEqual(2);
  expect(Number(await y.inputValue())).toBeGreaterThanOrEqual(90);
  // The first photo became the 대표 이미지 (the box was on: there was none).
  await expect(form.getByTestId('cover-card')).toBeVisible();
  await form.screenshot({ path: info.outputPath('form-filled.png') });
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);

  // In the room: each of the four views shows the photo of its name (the bath stands with 정면).
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: 'AI 방향 욕조' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const picker = dialog.getByRole('group', { name: 'AI 입력 시점' });
  const preview = picker.getByTestId('flux-view-preview');
  const readout = picker.getByTestId('flux-view-readout');
  await expect(preview.locator('canvas')).toHaveCount(1, { timeout: 30000 });
  const look = async (view: string) => {
    await expect(readout).toHaveText(view);
    await page.waitForTimeout(800);
    return colours(await preview.screenshot());
  };
  const front = await look('정면');
  expect(front.red).toBeGreaterThan(200);
  expect(front.blue + front.green).toBeLessThan(front.red / 20);
  await picker.getByRole('button', { name: '오른쪽으로 90° 돌리기', exact: true }).click();
  // Seen from the right the bath shows its 왼쪽 photo: its front (yellow band) to the picture's left.
  const right = await look('오른쪽');
  expect(right.blue).toBeGreaterThan(200);
  expect(right.yellow).toBeGreaterThan(20);
  expect(right.yellowX).toBeLessThan(right.blueX);
  await picker.getByRole('button', { name: '오른쪽으로 90° 돌리기', exact: true }).click();
  const back = await look('뒤');
  expect(back.green).toBeGreaterThan(200);
  expect(back.red + back.blue).toBeLessThan(back.green / 20);
  await picker.getByRole('button', { name: '오른쪽으로 90° 돌리기', exact: true }).click();
  // Seen from the left it shows its 오른쪽 photo (the 왼쪽 one turned over): the band on the right.
  const left = await look('왼쪽');
  expect(left.blue).toBeGreaterThan(200);
  expect(left.yellow).toBeGreaterThan(20);
  expect(left.yellowX).toBeGreaterThan(left.blueX);
  await expect(picker.getByTestId('flux-view-notes')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('room-left.png') });
  expect(errors).toEqual([]);
});

test('크기가 없으면 막고, 한도(429·402)는 남은 요청을 보내지 않으며, 취소·벽걸이·비대칭을 안내한다', async ({
  page,
}, info) => {
  app = await authenticatedApp(page);
  await installCutoutDouble(page);
  const sent: Sent[] = [];
  let mode: 'quota' | 'payment' | 'wait' | 'answer' = 'quota';
  const waiting: (() => void)[] = [];
  await mockModel(page, sent, async () => {
    if (mode === 'quota')
      return {
        status: 429,
        json: {
          error: 'Cloudflare AI 사용 한도를 모두 사용했어요. 한도가 갱신된 뒤 다시 시도해 주세요.',
          code: 'quota_exhausted',
        },
      };
    if (mode === 'payment')
      return { status: 402, json: { error: '결제 한도에 걸렸어요.', code: 'quota_exhausted' } };
    if (mode === 'answer') return undefined;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return { status: 499, json: { error: '취소' } };
  });
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('상품명').fill('AI 시험 욕조');
  // A new material's size follows its category (the standard model's) until a size is typed.
  const sizeIs = async (width: string, height: string, depth: string) => {
    await expect(form.getByLabel('가로 (mm)', { exact: true })).toHaveValue(width);
    await expect(form.getByLabel('높이 (mm)', { exact: true })).toHaveValue(height);
    await expect(form.getByLabel('깊이 (mm)', { exact: true })).toHaveValue(depth);
  };
  await expect(form.getByLabel('두께 (mm)', { exact: true })).toHaveValue('9');
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await sizeIs('400', '750', '680');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await sizeIs('600', '800', '480');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('450');
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await sizeIs('450', '800', '480');
  const generator = await openGenerator(form, ['1700', '560', '']);
  await expect(generator.getByTestId('ai-size-notice')).toContainText('가로·높이·깊이를 넣어 주세요.');
  await expect(generator.getByTestId('ai-guides')).toHaveCount(0);
  await addReference(generator);
  const make = generator.getByRole('button', { name: '방향 사진 만들기', exact: true });
  await expect(make).toBeDisabled();
  // A tile's 9 mm depth left after switching the category: out of the route's range, so no guide.
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('9');
  await expect(generator.getByTestId('ai-size-notice')).toContainText(
    '10~10,000mm로 넣어 주세요(지금 가로 1700 × 높이 560 × 깊이 9mm)',
  );
  await expect(generator.getByTestId('ai-guides')).toHaveCount(0);
  await expect(make).toBeDisabled();
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('750');
  await expect(generator.getByTestId('ai-guides').getByRole('img')).toHaveCount(4, { timeout: 30000 });
  await expect(generator.getByTestId('ai-size-notice')).toHaveCount(0);
  await expect(generator.getByTestId('ai-guide-size')).toContainText(
    '가로 1700 × 높이 560 × 깊이 750mm로 그렸어요.',
  );

  // A spent limit: the two requests in flight fail, the other four are never sent.
  await make.click();
  await expect(generator.getByTestId('ai-notice')).toContainText(
    'Cloudflare AI 사용 한도를 모두 사용했어요.',
  );
  expect(sent.length).toBeLessThanOrEqual(2);
  await expect(generator.getByText(/후보 1: Cloudflare AI 사용 한도/).first()).toBeVisible();
  mode = 'payment';
  sent.length = 0;
  await generator.getByRole('button', { name: '모두 다시 만들기', exact: true }).click();
  await expect(generator.getByTestId('ai-notice')).toContainText('결제 한도에 걸렸어요.');
  expect(sent.length).toBeLessThanOrEqual(2);
  await generator.screenshot({ path: info.outputPath('generator-limit.png') });

  // Cancel: nothing more is sent, and the notice says requests already sent may count.
  mode = 'wait';
  sent.length = 0;
  await generator.getByRole('button', { name: '모두 다시 만들기', exact: true }).click();
  await expect(generator.getByRole('status').filter({ hasText: '만드는 중 0/6' })).toBeVisible();
  await generator.getByRole('button', { name: '만들기 취소', exact: true }).click();
  await expect(generator.getByTestId('ai-notice')).toContainText(
    '취소했어요. 이미 보낸 요청은 사용량에 포함될 수 있어요.',
  );
  expect(sent.length).toBe(2);
  waiting.forEach((resolve) => resolve());

  // Not the same on both sides: 오른쪽 is made too (8 requests).
  await generator.getByLabel(/좌우 대칭 제품/).uncheck();
  await expect(generator.getByTestId('ai-guides')).toContainText('오른쪽 · 후보 2장을 만들어요');
  await expect(generator.getByTestId('ai-estimate')).toContainText('AI 요청 8회');

  // A wall basin: no 뒤 photo, its shape follows the installation.
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('wall');
  const basin = form.getByTestId('ai-direction-photos');
  await basin.getByText('AI로 방향 사진 만들기', { exact: true }).click();
  await expect(basin.getByLabel('가이드 모양', { exact: true })).toHaveValue('wall-round');
  await expect(basin.getByTestId('ai-guides')).toContainText(
    '뒤 · 벽에 거는 제품은 뒤 사진을 만들지 않아요',
    {
      timeout: 30000,
    },
  );
  await expect(basin.getByTestId('ai-guides').getByRole('img')).toHaveCount(4);
  await basin.screenshot({ path: info.outputPath('generator-basin.png') });

  // A toilet: its body and lid (a tankless one has no open lid), no 뒤, and both go with each request.
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('floor');
  const toilet = form.getByTestId('ai-direction-photos');
  await toilet.getByText('AI로 방향 사진 만들기', { exact: true }).click();
  const body = toilet.getByLabel('변기 몸통', { exact: true });
  const lid = toilet.getByLabel('변기 뚜껑', { exact: true });
  await expect(body).toHaveValue('two-piece');
  await expect(lid).toHaveValue('closed');
  await expect(lid.locator('option')).toHaveText(['뚜껑 닫힘', '뚜껑 열림', '시트만(뚜껑 없음)']);
  await body.selectOption('tankless');
  await expect(lid.locator('option')).toHaveText(['뚜껑 닫힘', '시트만(뚜껑 없음)']);
  await body.selectOption('one-piece');
  await lid.selectOption('seat');
  await expect(toilet.getByTestId('ai-guides')).toContainText(
    '뒤 · 변기는 벽에 붙여 설치해서 뒤 사진을 만들지 않아요',
    { timeout: 30000 },
  );
  await addReference(toilet);
  const angle = toilet.getByLabel('참고 사진 1 찍은 각도', { exact: true });
  await expect(angle).toHaveValue('unknown');
  await angle.selectOption('front-right');
  await expect(toilet.getByTestId('ai-estimate')).toContainText('AI 요청 4회');
  mode = 'answer';
  const before = sent.length;
  await toilet.getByRole('button', { name: '방향 사진 만들기', exact: true }).click();
  await expect(
    toilet.getByRole('group', { name: '왼쪽 후보' }).getByRole('button', { name: /후보 \d$/ }),
  ).toHaveCount(2, { timeout: 30000 });
  const toiletSent = sent.slice(before);
  expect(toiletSent.map((s) => s.spec.direction).sort()).toEqual(['front', 'front', 'left', 'left']);
  for (const s of toiletSent)
    expect(s.spec).toMatchObject({
      category: 'toilet',
      form: 'one-piece',
      lid: 'seat',
      installation: 'floor',
      photoAngles: ['front-right'],
    });
  await expect(toilet.getByRole('group', { name: '뒤 후보' })).toHaveCount(0);
  await toilet.screenshot({ path: info.outputPath('generator-toilet.png') });
  // A tile has no generator at all.
  await form.getByLabel('카테고리', { exact: true }).selectOption('tile');
  await expect(form.getByTestId('ai-direction-photos')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('게스트는 자재 등록을 열 수 없고, 로그인 없이 보낸 요청은 거절된다', async ({
  page,
  playwright,
  baseURL,
}) => {
  app = await authenticatedApp(page, { signedIn: false });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('button', { name: '신규 자재 등록', exact: true })).toHaveCount(0);
  // The real route of the running app, with no session: refused before any model call.
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const guide = await sharp({ create: { width: 496, height: 192, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const response = await anonymous.post('/api/materials/direction-photo', {
      headers: { origin: baseURL! },
      multipart: {
        guide: { name: 'guide.png', mimeType: 'image/png', buffer: guide },
        refs: { name: 'photo.png', mimeType: 'image/png', buffer: guide },
        seed: '1',
        spec: JSON.stringify({
          category: 'bath',
          form: 'oval-freestanding',
          direction: 'front',
          installation: 'floor',
          sizeMm: [1700, 560, 750],
        }),
      },
    });
    expect([401, 403, 503]).toContain(response.status());
    expect(response.headers()['content-type']).toContain('application/json');
    expect((await response.json()).code).toMatch(
      /authentication_required|authentication_unavailable|access_denied/,
    );
  } finally {
    await anonymous.dispose();
  }
});
