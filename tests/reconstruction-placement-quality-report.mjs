/** Compare immutable five-photo production replays without AI or image alteration. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = 'test-results/reconstruction-placement-quality-20260914';
const beforePhase = process.env.SJN_PLACEMENT_BEFORE ?? 'before-run-01';
const afterPhase = process.env.SJN_PLACEMENT_AFTER ?? 'after-run-01';
for (const value of [beforePhase, afterPhase]) assert.match(value, /^[a-z0-9-]+$/);
const beforeBytes = await readFile(`${root}/${beforePhase}/summary.json`);
const afterBytes = await readFile(`${root}/${afterPhase}/summary.json`);
const before = JSON.parse(beforeBytes.toString('utf8'));
const after = JSON.parse(afterBytes.toString('utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escape = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
assert.equal(before.cases.length, after.cases.length);
const cases = [];
for (const old of before.cases) {
  const current = after.cases.find((item) => item.id === old.id);
  assert(current);
  for (const field of ['inputSha256', 'rawReportSha256', 'rawObservationSha256'])
    assert.equal(current[field], old[field]);
  for (const field of ['room', 'originalRawCandidates', 'originalPlanes'])
    assert.deepEqual(current[field], old[field]);
  assert.deepEqual(
    current.entries.map((e) => e.id),
    old.entries.map((e) => e.id),
  );
  for (const candidate of current.entries) {
    const oldCandidate = old.entries.find((item) => item.id === candidate.id);
    assert.deepEqual(candidate.currentCandidate.colorEvidence, oldCandidate.currentCandidate.colorEvidence);
  }
  for (const item of [old, current]) {
    assert.equal(item.reused, true);
    assert.equal(item.rawUnchanged, true);
    assert.equal(item.afterEmpty, true);
    assert.equal(item.saveReloadUnchanged, true);
    assert.equal(item.duplicatePreserved, true);
  }
  const pngs = {};
  for (const [key, phase] of [
    ['before', beforePhase],
    ['after', afterPhase],
  ]) {
    const path = `${root}/${phase}/${old.id}/before.png`;
    pngs[key] = { path, sha256: sha(await readFile(path)) };
  }
  cases.push({
    id: old.id,
    inputSha256: current.inputSha256,
    rawObservationSha256: current.rawObservationSha256,
    rawReportSha256: current.rawReportSha256,
    analysisRevision: current.originalAnalysisCache?.analysisRevision,
    engineRevision: current.originalEngine.engineMetadata.revision,
    observationAndPlaneIdentity: true,
    candidateIdsUnchanged: true,
    colorEvidenceUnchanged: true,
    beforeFixtureCount: old.fixtureCount,
    afterFixtureCount: current.fixtureCount,
    beforePngUnchanged: pngs.before.sha256 === pngs.after.sha256,
    pngs,
    creationMs: current.creationMs,
    renderMs: current.renderMs,
    pageHeapUsedBytes: current.heap.after.usedSize,
    candidateChanges: current.entries
      .filter((entry) => {
        const previous = old.entries.find((item) => item.id === entry.id);
        return (
          previous.newStatus !== entry.newStatus ||
          JSON.stringify(previous.requested) !== JSON.stringify(entry.requested) ||
          previous.warning !== entry.warning
        );
      })
      .map((entry) => {
        const previous = old.entries.find((item) => item.id === entry.id);
        return {
          id: entry.id,
          kind: entry.kind,
          beforeStatus: previous.newStatus,
          afterStatus: entry.newStatus,
          beforeRequested: previous.requested,
          afterRequested: entry.requested,
          beforeReason: previous.warning,
          afterReason: entry.warning,
          afterReview: entry.review,
        };
      }),
  });
}
for (const run of [before, after]) {
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.external, []);
  assert.equal(run.workers, 0);
}
const result = {
  scope:
    'Same real cached observations, no user correction, no new AI. Raw inputs and candidate identity/evidence preserved. Counts are not correctness scores. Source-camera reconstruction remains not-evaluable.',
  beforePhase,
  afterPhase,
  beforeSummarySha256: sha(beforeBytes),
  afterSummarySha256: sha(afterBytes),
  beforeBundleSha256: before.bundleSha256,
  afterBundleSha256: after.bundleSha256,
  browser: after.browser,
  gpu: after.gpu,
  memoryScope: after.memoryScope,
  errors: after.errors,
  external: after.external,
  workers: after.workers,
  cases,
};
await writeFile(`${root}/comparison-verification.json`, JSON.stringify(result, null, 2));
const sections = cases
  .map(
    (item) =>
      `<section><h2>${escape(item.id)}</h2><p>자동 모형 ${item.beforeFixtureCount} → ${item.afterFixtureCount}개 · ${item.beforePngUnchanged ? 'PNG 동일' : 'PNG 변경'} · 사용자 보정 없음</p><div class="grid">${[
        [`${beforePhase}/${item.id}/original.jpg`, '원사진'],
        [`${beforePhase}/${item.id}/before.png`, '이전 자동 결과'],
        [`${afterPhase}/${item.id}/before.png`, '변경 후 자동 결과'],
      ]
        .map(
          ([path, label]) =>
            `<figure><img src="${escape(path)}" alt="${escape(item.id + ' ' + label)}"><figcaption>${label}</figcaption></figure>`,
        )
        .join(
          '',
        )}</div><details><summary>후보별 변경 이유</summary>${item.candidateChanges.map((entry) => `<p><strong>${escape(entry.id)} · ${escape(entry.kind)}</strong><br>${escape(entry.afterReason ?? '')}</p>`).join('')}</details></section>`,
  )
  .join('');
await writeFile(
  `${root}/comparison.html`,
  `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>자동 배치 전후 비교</title><style>body{max-width:1500px;margin:auto;padding:24px;font:16px/1.6 system-ui;background:#f1f4f2;color:#263b35}section{background:white;padding:20px;margin:20px 0;border-radius:12px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0}img{width:100%;height:350px;object-fit:contain}figcaption{text-align:center}details{margin-top:16px;overflow-wrap:anywhere}@media(max-width:700px){.grid{grid-template-columns:1fr}img{height:320px}}</style><h1>사진 → Before 자동 배치 변경 전후</h1><p>실제 저장 관측의 분석 캐시 v6 · 엔진 v8을 동일하게 재생했다. 새 추론·사용자 수정은 없다. 다섯 사진은 이미 개발에 사용한 회귀 사례이며 가정한 방 치수는 실측이 아니다. 원사진 시점의 정확도는 평가 불가다.</p><p><strong>자동 배치 수와 시각 재현 품질은 개선되지 않았다.</strong> 확인되지 않은 바닥 대응과 방향 가정을 제외하면서 user-04 하부장도 확인 대상으로 남았다. 사용자 확인 결과는 별도 검증으로 기록한다.</p><p><a href="comparison-verification.json">입력·관측·후보·색상 보존 및 실행 결과</a> · <a href="${beforePhase}/source-manifest.json">이전 소스</a> · <a href="${afterPhase}/source-manifest.json">변경 후 소스</a></p>${sections}</html>`,
);
console.log(
  JSON.stringify({
    cases: cases.map(({ id, beforeFixtureCount, afterFixtureCount, beforePngUnchanged }) => ({
      id,
      beforeFixtureCount,
      afterFixtureCount,
      beforePngUnchanged,
    })),
    output: `${root}/comparison.html`,
  }),
);
