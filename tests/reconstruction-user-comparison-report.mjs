import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const root = resolve(process.argv[2] ?? 'test-results/user-reconstruction-improvement-20260913');
const scope = relative(resolve('test-results'), root);
if (!scope || scope.startsWith('..') || isAbsolute(scope))
  throw new Error('Use a private test-results directory.');
const stage = process.argv[3] ?? 'after';
const prefix = process.argv[4] ?? 'comparison';
const previousStage = process.argv[5] ?? 'before';
if (![stage, prefix, previousStage].every((value) => /^[a-z0-9-]+$/.test(value)))
  throw new Error('Use simple report names.');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const load = async (path) => {
  try {
    return JSON.parse(await readFile(resolve(root, path), 'utf8'));
  } catch {
    return undefined;
  }
};
const seconds = (value) => (typeof value === 'number' ? `${(value / 1000).toFixed(2)}초` : '미측정');
const records = [];
const cards = [];
for (const item of manifest.cases) {
  const before = await load(`${previousStage}/${item.id}/baseline.json`);
  const baseline = await load(`${stage}/${item.id}/baseline.json`);
  const candidate = await load(`${stage}/${item.id}/candidate.json`);
  const completion = await load(`${stage}/${item.id}/completion.json`);
  const original = `data:image/jpeg;base64,${(await readFile(resolve(item.input.path))).toString('base64')}`;
  const summary = (report) =>
    report
      ? {
          totalMs: report.totalMs,
          execution: report.execution,
          engineMetadata: report.engineMetadata,
          rawCount:
            report.pipeline?.automaticUnderstanding?.candidates.length ??
            report.rawSegmentationCandidates?.length,
          placedCount: report.fixtures.length,
          placed: report.fixtures.map((f) => ({
            kind: f.reconstruction?.kind,
            shape: f.reconstruction?.basinShape,
            bowlCount: f.reconstruction?.bowlCount,
            support: f.reconstruction?.basinVariant,
            wall: f.roomPlacement?.face,
            baseHeightMm: f.reconstruction?.baseHeightMm,
            provenance: f.reconstruction?.provenance,
          })),
          camera: report.pipeline?.camera,
          resolution: report.pipeline?.resolution,
          timing: report.timing,
        }
      : undefined;
  records.push({
    id: item.id,
    split: item.split,
    inputHash: item.input.sha256,
    before: summary(before),
    baseline: summary(baseline),
    candidate: summary(candidate),
    failure: completion?.status === 'candidate-failed' ? completion.error : undefined,
  });
  const figure = (name, path, report) =>
    `<figure><figcaption>${escape(name)}</figcaption>${
      report
        ? `<button class="zoom" data-image="${escape(path)}" aria-label="${escape(name)} 확대"><img src="${escape(path)}" alt="${escape(name)}" loading="lazy"></button><p>실제 배치 ${report.fixtures.length}개 · ${seconds(report.totalMs)}</p><a href="${escape(path.replace(/\.png$/, '.json'))}">실행 JSON</a>`
        : `<div class="missing">${escape(completion?.error ?? '결과 없음')}</div>`
    }</figure>`;
  cards.push(`<section><h2>${escape(item.id)} <small>${item.split === 'development' ? '사용자 개발 사례' : '기존 별도 평가 사례 · 회귀'}</small></h2>
    <div class="grid"><figure><figcaption>원본 사진</figcaption><button class="zoom" data-image="${original}" aria-label="원본 확대"><img src="${original}" alt="원본 사진" loading="lazy"></button><p>${item.input.width} × ${item.input.height}px · 공간 입력 ${item.roomMm.width} × ${item.roomMm.depth} × ${item.roomMm.height}mm</p></figure>
    ${figure(previousStage === 'before' ? '수정 전 기준선 로직 재실행' : '직전 저장된 기존 분석', `${previousStage}/${item.id}/baseline.png`, before)}
    ${figure('수정 후 기존 분석', `${stage}/${item.id}/baseline.png`, baseline)}
    ${figure('수정 후 추가 모델 후보', `${stage}/${item.id}/candidate.png`, candidate)}</div>
    ${candidate?.execution ? `<p class="status">관측 출력 ${candidate.execution.counts.rawCandidates}개 → 정리 후 검토 대상 ${candidate.execution.counts.organizedFixtures}개 → 실제 배치 ${candidate.execution.counts.placedFixtures}개 / 확인 필요 ${candidate.execution.counts.needsReview}개</p>` : ''}
    ${candidate?.timing ? `<p>후보 실행의 기존 분석: ${candidate.reuse?.baseline.reused ? '재사용 · 새 추론 없음' : seconds(candidate.timing.baselineAnalysisMs)} · 추가 모델: ${seconds(candidate.timing.additionalModelMs)} · 배치 및 기타 준비: ${seconds(candidate.timing.placementAndPreparationMs)} · PNG: ${seconds(candidate.timing.renderMs)}</p>` : ''}
    <details><summary>설비·출처·보류 진단</summary><pre>${escape(JSON.stringify(records.at(-1), null, 2))}</pre></details></section>`);
}
await writeFile(resolve(root, `${prefix}-summary.json`), JSON.stringify(records, null, 2));
await writeFile(
  resolve(root, `${prefix}.html`),
  `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>사진 재구성 수정 전후 검증</title>
<style>body{margin:0;background:#f4f5f4;color:#253532;font:15px/1.6 system-ui,sans-serif}main{max-width:1800px;margin:auto;padding:32px}h1{font-size:30px}h2{font-size:22px}small{font-size:14px;font-weight:400;color:#576760}section{background:white;padding:22px;margin:24px 0;border:1px solid #d9e0dc;border-radius:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{font-weight:700;margin:0 0 10px}.zoom{border:0;background:#eef0ee;display:block;width:100%;padding:0;cursor:zoom-in}.zoom img{width:100%;height:300px;object-fit:contain;display:block}p{margin:10px 0}a{color:#176c59}.missing{height:300px;display:grid;place-items:center;background:#f7ece7;padding:16px;box-sizing:border-box}.status{font-weight:700;padding:12px;background:#edf5f0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;max-height:500px;overflow:auto}dialog{max-width:94vw;padding:12px;border:0;border-radius:10px}dialog::backdrop{background:#000b}dialog img{display:block;max-width:88vw;max-height:84vh;object-fit:contain}dialog button{margin-bottom:8px;padding:8px 18px}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){main{padding:12px}.grid{grid-template-columns:1fr}}</style>
<main><h1>사진 재구성 수정 전후 검증</h1><p>실제 모델 실행으로 생성한 자동 결과 비교. 수동으로 정답 설비를 넣지 않았으며 배치 보류를 성공으로 집계하지 않습니다. 이미지를 누르면 확대할 수 있습니다.</p><p>${previousStage === 'before' ? '수정 전은 보관한 이전 분석 소스로 다시 실행한 기준선입니다.' : '직전 비교 열은 이전 단계에서 저장한 실제 분석 결과이며 이번 실행으로 덮어쓰지 않았습니다.'} 실행 시점·환경의 차이가 있으므로 시간은 절대 성능 개선 비율로 해석하지 않습니다. 별도 평가 사진은 이전 평가에서 사용한 회귀 사례이며 새 미공개 평가셋이 아닙니다.</p>${cards.join('')}</main>
<dialog><button type="button">닫기</button><img alt="선택한 비교 이미지 확대"></dialog><script>const dialog=document.querySelector('dialog');document.querySelectorAll('[data-image]').forEach(button=>button.addEventListener('click',()=>{dialog.querySelector('img').src=button.dataset.image;dialog.showModal()}));dialog.querySelector('button').addEventListener('click',()=>dialog.close());</script></html>`,
  'utf8',
);
process.stdout.write(
  JSON.stringify({ report: resolve(root, `${prefix}.html`), cases: records.length }) + '\n',
);

if (process.env.RECONSTRUCTION_VERIFY_REPORT === '1') {
  const { chromium } = await import('@playwright/test');
  const { pathToFileURL } = await import('node:url');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(resolve(root, `${prefix}.html`)).href);
    const sections = page.locator('section');
    if ((await sections.count()) !== records.length) throw new Error('Missing comparison cases');
    const images = await page.locator('section img').evaluateAll(async (elements) => {
      elements.forEach((element) => {
        element.loading = 'eager';
      });
      await Promise.race([
        Promise.all(elements.map((element) => element.decode())),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image decode timed out')), 15000)),
      ]);
      return elements.map((element) => ({
        src: element.getAttribute('src')?.startsWith('data:') ? 'private-input' : element.getAttribute('src'),
        loaded: element.naturalWidth > 0,
      }));
    });
    if (images.some((item) => !item.loaded)) throw new Error('Unloaded comparison image');
    for (let index = 0; index < records.length; index++) {
      if (records[index].split === 'development')
        await sections.nth(index).screenshot({ path: resolve(root, `${prefix}-${records[index].id}.png`) });
    }
    await sections.first().locator('.zoom').first().click();
    const zoomOpened = await page.locator('dialog').evaluate((element) => element.open);
    if (!zoomOpened || errors.length) throw new Error('Comparison browser verification failed');
    await writeFile(
      resolve(root, `${prefix}-ui-check.json`),
      JSON.stringify({ sections: records.length, images, zoomOpened, errors }, null, 2),
    );
  } finally {
    await browser.close();
  }
}
