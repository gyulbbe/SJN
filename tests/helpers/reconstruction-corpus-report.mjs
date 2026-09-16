import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { evaluateCorpusCase, summarizeCorpusMetrics } from '../reconstruction-corpus-metrics.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const number = (value, digits = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '미측정';
const seconds = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)}초` : '미측정';
const mib = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${(value / 1024 ** 2).toFixed(1)} MiB` : '미측정';
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? escapeHtml(url.href) : undefined;
  } catch {
    return undefined;
  }
};

async function optionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot parse ${path.basename(file)}: ${error.message}`);
  }
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
function engineSignature(metadata) {
  if (!metadata) return undefined;
  return JSON.stringify({
    modelId: metadata.modelId,
    modelRevision: metadata.modelRevision,
    revision: metadata.revision,
    settings: Object.fromEntries(
      Object.entries(metadata.settings ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}

/** Loads every manifest case; a missing completion marker never legitimizes stale report files. */
export async function collectCorpusReport(manifest, manifestHash, directory, projectRoot) {
  const issues = [],
    environments = [];
  for (const split of ['all', 'development', 'heldout']) {
    const environment = await optionalJson(path.join(directory, `environment-${split}.json`));
    if (environment) environments.push(environment);
  }
  const codeHashes = new Set(environments.map((item) => item.codeHash).filter(Boolean));
  const signatures = { baseline: new Set(), candidate: new Set() };
  const cases = [];
  for (const entry of manifest.cases) {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) throw new Error('Invalid corpus case id.');
    const caseIssues = [];
    const original = path.resolve(projectRoot, entry.input.path);
    const input = await fs.readFile(original);
    if (sha256(input) !== entry.input.sha256) throw new Error(`Frozen input changed: ${entry.id}`);
    const caseDirectory = path.join(directory, entry.id);
    const completion = await optionalJson(path.join(caseDirectory, 'completion.json'));
    const record = { entry, original, completion, issues: caseIssues, engines: {}, attempted: !!completion };
    if (completion) {
      if (completion.id !== entry.id) caseIssues.push('완료 기록의 사진 ID가 다릅니다.');
      if (completion.manifestHash !== manifestHash)
        caseIssues.push('완료 기록의 정답/입력 자료집 해시가 다릅니다.');
      if (completion.inputHash && completion.inputHash !== entry.input.sha256)
        caseIssues.push('완료 기록의 입력 해시가 다릅니다.');
      if (!completion.codeHash) caseIssues.push('완료 기록에 구현 해시가 없습니다.');
      else codeHashes.add(completion.codeHash);
      if (!['complete', 'candidate-failed', 'failed'].includes(completion.status))
        caseIssues.push('알 수 없는 완료 상태입니다.');
      if (completion.external?.length)
        caseIssues.push('실행 중 외부 브라우저 요청이 기록됐습니다. 원인을 확인하세요.');
      if (completion.errors?.length) caseIssues.push('브라우저 실행 오류가 기록됐습니다.');
    }
    for (const engine of ['baseline', 'candidate']) {
      const permitted =
        completion &&
        (completion.status === 'complete' ||
          (engine === 'baseline' && completion.status === 'candidate-failed'));
      if (!completion) {
        record.engines[engine] = { status: 'not-run', reason: '완료 기록 없음: 실행 전 또는 진행 중입니다.' };
        continue;
      }
      if (!permitted) {
        const reason = completion.error ?? '실행이 완료되지 않았습니다.';
        record.engines[engine] = {
          status: 'failed',
          reason,
          metrics: evaluateCorpusCase(entry, undefined, { error: reason }),
        };
        continue;
      }
      const report = await optionalJson(path.join(caseDirectory, `${engine}.json`));
      if (!report) {
        const reason = '완료 기록은 있으나 해당 엔진의 JSON이 없습니다.';
        caseIssues.push(reason);
        record.engines[engine] = {
          status: 'failed',
          reason,
          metrics: evaluateCorpusCase(entry, undefined, { error: reason }),
        };
        continue;
      }
      if (report.engineMetadata?.id !== engine) caseIssues.push(`${engine} JSON의 엔진 ID가 다릅니다.`);
      if (report.correctionOfRunId) caseIssues.push('사용자 교정 결과는 자동 비교 결과로 합산하지 않습니다.');
      const metrics = evaluateCorpusCase(entry, report);
      const png = path.join(caseDirectory, `${engine}.png`);
      const hasPng = await exists(png);
      if (!hasPng) caseIssues.push(`${engine} 결과 PNG가 없습니다.`);
      const signature = engineSignature(report.engineMetadata);
      if (signature) signatures[engine].add(signature);
      if (metrics.status !== 'completed') caseIssues.push(`${engine}: ${metrics.error}`);
      record.engines[engine] = {
        status: metrics.status === 'completed' ? 'complete' : 'failed',
        report,
        png: hasPng ? png : undefined,
        metrics,
        reason: metrics.error,
      };
    }
    // A failed candidate still has an actual runtime/model fingerprint in diagnostics.
    if (completion?.status === 'candidate-failed' && completion.diagnostics?.modelId) {
      const diagnostic = completion.diagnostics;
      const candidateEnvironment = environments.find((item) => item.model?.modelId === diagnostic.modelId);
      if (
        candidateEnvironment?.model?.revision &&
        diagnostic.modelRevision !== candidateEnvironment.model.revision
      )
        caseIssues.push('실패한 후보의 모델 revision이 실행 환경과 다릅니다.');
      record.failedCandidateModel = {
        modelId: diagnostic.modelId,
        modelRevision: diagnostic.modelRevision,
        promptRevision: diagnostic.promptRevision,
        settings: diagnostic.settings,
        measurement: diagnostic.measurement,
      };
    }
    issues.push(...caseIssues.map((message) => `${entry.id}: ${message}`));
    cases.push(record);
  }
  for (const environment of environments)
    if (environment.manifestHash !== manifestHash) issues.push('환경 기록의 manifest 해시가 다릅니다.');
  if (codeHashes.size !== 1)
    issues.push(
      codeHashes.size ? '서로 다른 구현 해시의 결과가 섞였습니다.' : '구현 해시를 확인할 수 없습니다.',
    );
  for (const engine of ['baseline', 'candidate'])
    if (signatures[engine].size > 1)
      issues.push(`${engine} 모델/revision/설정이 서로 다른 결과가 섞였습니다.`);
  const candidateSettings = cases.flatMap((item) => {
    const report = item.engines.candidate.report;
    const failed = item.failedCandidateModel;
    if (report)
      return [
        JSON.stringify({
          modelId: report.engineMetadata.modelId,
          revision: report.engineMetadata.modelRevision,
          prompt: report.engineMetadata.settings?.promptRevision,
          settings: report.pipeline?.model?.settings ?? null,
        }),
      ];
    return failed
      ? [
          JSON.stringify({
            modelId: failed.modelId,
            revision: failed.modelRevision,
            prompt: failed.promptRevision,
            settings: failed.settings ?? null,
          }),
        ]
      : [];
  });
  if (new Set(candidateSettings).size > 1)
    issues.push('성공/실패 후보 기록 사이에 모델 또는 실제 요청 설정이 다릅니다.');
  const attempted = cases.filter((item) => item.attempted).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifestHash,
    codeHash: codeHashes.size === 1 ? [...codeHashes][0] : null,
    complete: attempted === manifest.cases.length && issues.length === 0,
    aggregationAllowed: issues.length === 0,
    totalCases: manifest.cases.length,
    attemptedCases: attempted,
    notRunCases: cases.filter((item) => !item.attempted).map((item) => item.entry.id),
    issues,
    environments,
    cases,
  };
}

export function corpusSummary(snapshot) {
  const summaries = {};
  for (const engine of ['baseline', 'candidate']) {
    const evaluations = snapshot.cases.map((item) => item.engines[engine].metrics).filter(Boolean);
    summaries[engine] = snapshot.aggregationAllowed ? summarizeCorpusMetrics(evaluations) : null;
  }
  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    state: snapshot.complete ? 'complete' : 'incomplete-do-not-report-as-final',
    totalCases: snapshot.totalCases,
    attemptedCases: snapshot.attemptedCases,
    notRunCases: snapshot.notRunCases,
    manifestHash: snapshot.manifestHash,
    codeHash: snapshot.codeHash,
    aggregationAllowed: snapshot.aggregationAllowed,
    issues: snapshot.issues,
    summaries,
    evaluations: Object.fromEntries(
      ['baseline', 'candidate'].map((engine) => [
        engine,
        snapshot.cases.map((item) => item.engines[engine].metrics).filter(Boolean),
      ]),
    ),
    environment: snapshot.environments,
    limitations: [
      'All corpus photographs remain listed, including failures and unattempted cases.',
      'Partial snapshots are not final evaluation results.',
      'No mixed implementation/model/settings aggregate is permitted.',
      'Model observations, default templates and actual placed fixtures are separate.',
      'Independent Codex source annotations are not human-adjudicated or measured geometry truth.',
      'No composite accuracy or automatic adoption decision.',
    ],
  };
}

function engineCard(record, engine) {
  const item = record.engines[engine];
  const title = engine === 'baseline' ? '기존 분석' : '개선 후보';
  const status = item.status === 'complete' ? '완료' : item.status === 'failed' ? '실패' : '미실행 / 진행 중';
  const report = item.report;
  const raw =
    engine === 'candidate'
      ? (report?.pipeline?.automaticUnderstanding?.candidates ?? report?.pipeline?.understanding?.candidates)
      : (report?.rawSegmentationCandidates ?? report?.rawReview?.candidates);
  const held =
    engine === 'candidate'
      ? report?.pipeline?.placements?.filter((candidate) => candidate.status === 'held').length
      : report?.review?.candidates?.filter((candidate) => candidate.status !== 'placed').length;
  const heldDetails =
    engine === 'candidate'
      ? (report?.pipeline?.placements ?? [])
          .filter((item) => item.status === 'held')
          .map((item) => ({
            kind:
              report?.pipeline?.understanding?.candidates?.find(
                (candidate) => candidate.id === item.candidateId,
              )?.kind ?? 'unknown',
            reason: item.reasons?.join(' ') ?? '추가 확인 필요',
          }))
      : (report?.review?.candidates ?? [])
          .filter((item) => item.status !== 'placed')
          .map((item) => ({
            kind: item.kind,
            reason: item.warning ?? item.installation?.reason ?? '추가 확인 필요',
          }));
  const applied = report?.fixtures?.length;
  const asset = `assets/${record.entry.id}-${engine}.png`;
  const sourceProjection = item.metrics?.reprojections?.length ?? 0;
  const stats = item.metrics?.recognized;
  const predictionDetail = stats
    ? `<details><summary>자동 인식 평가 상세</summary><p>영역 대응 ${stats.counts.objectBoxMatches}, 종류 오류 ${stats.counts.matchedWrongKind}, 누락 영역 ${stats.counts.missingPhysicalBounds}, 잘못 추가 ${stats.counts.falseAdded}, 반사 추가 ${stats.counts.reflectedFalseAdded}, 중복 ${stats.counts.duplicateAdded}. 높은 외곽 불확실성 ${stats.counts.highUncertaintyNeedsReview}개는 별도 확인.</p><p>설치 벽: 맞음 ${stats.attributes.wall.correct} / 틀림 ${stats.attributes.wall.incorrect} / 보류 ${stats.attributes.wall.abstained}; 알려진 대응 ${stats.attributes.wall.knownMatched}개만 분모.</p><p>실제 모형의 원본 시점 재투영 평가 가능 ${sourceProjection}개. 입력 bbox 대응을 재투영 성공으로 세지 않음.</p></details>`
    : '';
  return `<section class="engine ${escapeHtml(item.status)}"><h3>${title} <span class="badge">${status}</span></h3>${item.png ? `<a class="image" href="${asset}" target="_blank"><img src="${asset}" loading="lazy" alt="${escapeHtml(record.entry.id)} ${title} 결과"></a>` : `<div class="empty">${escapeHtml(item.reason ?? '확인할 결과 이미지가 없습니다.')}</div>`}<div class="details">${report ? `<p class="counts">원시 후보 ${number(raw?.length)} · 실제 배치 ${number(applied)} · ${engine === 'baseline' ? '미배치' : '보류'} ${number(held)}</p><p>전체 ${seconds(report.totalMs)} · 준비/생성 ${seconds(report.creationMs)} · 렌더 ${seconds(report.renderMs)}</p><p>입력 ${number(report.input?.width)}×${number(report.input?.height)} · DeepLab 분석 ${number(report.input?.analysisWidth)}×${number(report.input?.analysisHeight)} · 출력 ${number(report.output?.width)}×${number(report.output?.height)}</p><p>메인 페이지 JS heap 최대 ${mib(report.measurement?.mainPageJsHeapPeakBytes)} <small>Worker/WASM/GPU 제외</small></p><p><a href="assets/${record.entry.id}-${engine}.json">상세 JSON</a>${item.png ? ` · <a href="${asset}" download>PNG 다운로드</a>` : ''}</p>${predictionDetail}<details><summary>모형·설치 보류 사유</summary><ul>${heldDetails.map((candidate) => `<li>${escapeHtml(candidate.kind)}: ${escapeHtml(candidate.reason)}</li>`).join('') || '<li>해당 목록 없음</li>'}</ul></details><details><summary>모델·설정</summary><pre>${escapeHtml(JSON.stringify(report.engineMetadata, null, 2))}</pre></details>` : `<p>${escapeHtml(item.reason ?? '미실행')}</p>${engine === 'candidate' && record.failedCandidateModel ? `<p>실제 모델 요청 ${seconds(record.failedCandidateModel.measurement?.requestMs)}</p><details><summary>실패 실행 모델 정보</summary><pre>${escapeHtml(JSON.stringify(record.failedCandidateModel, null, 2))}</pre></details>` : ''}`}</div></section>`;
}

function summaryTables(summary) {
  if (!summary.aggregationAllowed)
    return '<p class="warning">구현·모델·입력 기록의 불일치가 있어 자동 합계를 생성하지 않았습니다. 아래 모든 사진은 개별 확인용입니다.</p>';
  const rows = [];
  for (const engine of ['baseline', 'candidate'])
    for (const split of ['development', 'heldout']) {
      const group = summary.summaries[engine]?.groups?.[split];
      if (!group) {
        rows.push(`<tr><td>${engine}</td><td>${split}</td><td colspan="9">미실행</td></tr>`);
        continue;
      }
      const raw = group.recognized,
        applied = group.applied;
      rows.push(
        `<tr><td>${engine}</td><td>${split}</td><td>${group.attemptedCases}</td><td>${group.failedCases.length}</td><td>${number(raw?.counts?.objectBoxMatches)}</td><td>${number(raw?.counts?.matchedWrongKind)}</td><td>${number(raw?.counts?.missingPhysicalBounds)}</td><td>${number(raw?.counts?.falseAdded)}</td><td>${number(raw?.counts?.reflectedFalseAdded)}</td><td>${number(applied?.counts?.predictedPhysical)}</td><td>${number(applied?.counts?.missingPhysicalBounds)}</td></tr>`,
      );
    }
  return `<div class="table-scroll"><table><thead><tr><th>엔진</th><th>분할</th><th>실행</th><th>실패</th><th>인식 영역 대응</th><th>대응 종류 오류</th><th>인식 누락 영역</th><th>거짓 추가</th><th>반사 추가</th><th>실제 배치</th><th>모형 누락 영역</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="muted">미측정은 0이 아닙니다. bbox가 대응해도 종류·설치·형태가 맞는 것은 아닙니다. 실패 사례는 실행/실패 수에 포함하고, 성공 보고서의 알려진 속성에 대한 분모는 <a href="summary.json">집계 JSON</a>에 따로 표시합니다.</p>`;
}

export function renderCorpusHtml(snapshot, summary) {
  const cards = snapshot.cases
    .map((record) => {
      const entry = record.entry,
        source = entry.source;
      const link = safeLink(source.page),
        license = safeLink(source.licenseUrl);
      const outcome = !record.attempted
        ? 'not-run'
        : record.engines.candidate.status === 'failed' || record.engines.baseline.status === 'failed'
          ? 'failed'
          : 'complete';
      return `<article class="case" data-split="${escapeHtml(entry.split)}" data-status="${outcome}" data-search="${escapeHtml((entry.id + ' ' + source.title).toLowerCase())}"><header><h2>${escapeHtml(entry.id)} <span class="badge">${entry.split === 'heldout' ? '최종 평가' : '개발'}</span></h2><p>${escapeHtml(source.title)}</p><p>두 엔진 공통 입력 ${entry.input.width}×${entry.input.height} · 방 ${entry.roomMm.width}×${entry.roomMm.depth}×${entry.roomMm.height}mm <strong>(실측 아님)</strong> · 정답 설비 ${entry.annotation.fixtures.length}개</p></header>${record.issues.length ? `<p class="warning">${record.issues.map(escapeHtml).join('<br>')}</p>` : ''}<div class="comparison"><section class="original"><h3>원본 평가 입력</h3><a class="image" href="assets/${entry.id}-original.jpg" target="_blank"><img src="assets/${entry.id}-original.jpg" loading="lazy" alt="${escapeHtml(entry.id)} 원본 욕실 사진"></a><div class="details"><p>${escapeHtml(source.author)} · ${license ? `<a href="${license}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.license)}</a>` : escapeHtml(source.license)}${link ? ` · <a href="${link}" target="_blank" rel="noopener noreferrer">공식 출처</a>` : ''}</p><p>변경: 방향 정규화, 최대 1000px 축소, JPEG 재인코딩.</p><details><summary>후보 실행 전 고정한 관측 주석</summary><ul>${entry.annotation.fixtures.map((fixture) => `<li>${escapeHtml(fixture.kind)} · 설치 ${escapeHtml(fixture.mounting)} / 벽 ${escapeHtml(fixture.installationWall)} / 형태 ${escapeHtml(fixture.shape)}${fixture.basinVariant ? ` / 지지 ${escapeHtml(fixture.basinVariant)}` : ''}${fixture.notes ? `<br>${escapeHtml(fixture.notes)}` : ''}</li>`).join('')}</ul><p>독립 Codex 원본 판독이며 사람 검수나 실측 정답이 아닙니다.</p></details></div></section>${engineCard(record, 'baseline')}${engineCard(record, 'candidate')}</div><footer>입력 SHA256 <code>${escapeHtml(entry.input.sha256)}</code>${record.completion ? `<br>케이스 전체 Ollama 모델 할당 관측 최대 ${mib(record.completion.modelVramPeakBytes)} (전체 GPU 사용량 아님)` : ''}</footer></article>`;
    })
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>SJN 사진 재구성 · 독립 평가 비교</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f4f2;color:#20302b;font:15px/1.65 system-ui,sans-serif}main{max-width:1800px;margin:auto;padding:26px}h1{font-size:30px;line-height:1.25}h2{font-size:22px}h3{margin:0;padding:14px 16px;border-bottom:1px solid #e0e6e2;font-size:17px}a{color:#096b55}code,pre{font-family:ui-monospace,monospace;word-break:break-all}pre{white-space:pre-wrap;font-size:12px}header p{margin:5px 0}.intro,.case{background:#fff;border:1px solid #dbe3dd;border-radius:12px;overflow:hidden;margin-bottom:24px}.intro{padding:24px}.case>header,.case>footer{padding:18px 20px}.case>footer{font-size:12px;background:#f8faf8}.comparison{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #dbe3dd}.comparison>section{min-width:0;border-right:1px solid #dbe3dd}.comparison>section:last-child{border:0}.image,.empty{width:100%;height:390px;background:#e9edea;display:flex;align-items:center;justify-content:center}.image img{display:block;max-width:100%;max-height:100%;object-fit:contain}.empty{padding:28px;color:#6f453a;text-align:center}.details{padding:14px 16px}.details p{margin:6px 0;font-size:13px}.counts{font-size:15px!important;font-weight:700}.badge{display:inline-block;background:#e4efe9;color:#285b48;border-radius:15px;padding:2px 9px;font-size:12px;font-weight:600}.failed .badge{background:#fde6df;color:#943b24}.not-run .badge{background:#e9e9e9;color:#626262}.warning{padding:14px 18px;background:#fff0d8;color:#744713;border:1px solid #e4c795}.muted,small{color:#65786f}details{margin-top:10px}summary{cursor:pointer;font-weight:600}details li{margin-bottom:6px}table{border-collapse:collapse;min-width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd;white-space:nowrap}th{background:#edf3ee}.table-scroll{overflow:auto}.filters{position:sticky;top:0;z-index:2;display:flex;gap:14px;flex-wrap:wrap;padding:14px 18px;border:1px solid #dbe3dd;background:#f9fcfa;margin:16px 0}select,input{font:inherit;padding:7px;border:1px solid #b6c8bc;border-radius:5px;max-width:100%}.filters label{display:flex;align-items:center;gap:7px}.case[hidden]{display:none}.footer-note{padding:20px}ul{padding-left:21px}@media(max-width:900px){main{padding:12px}.comparison{grid-template-columns:1fr}.comparison>section{border-right:0;border-bottom:1px solid #dbe3dd}.image,.empty{height:340px}.intro{padding:17px}h1{font-size:25px}}@media print{.filters{display:none}.case{break-inside:avoid}.image{height:250px}body{background:white}}
</style></head><body><main><section class="intro"><h1>사진 재구성 · 독립 평가 비교</h1><p>${snapshot.complete ? '전체 케이스의 최종 실행 기록이 갖춰졌습니다.' : '<strong>미완료 스냅샷 — 최종 성능 수치로 사용하지 마세요.</strong>'} ${snapshot.attemptedCases}/${snapshot.totalCases}장 완료 기록. 모든 사진과 실패를 아래에 표시합니다.</p><p>원본 입력 · 기존 DeepLab 분석 · 로컬 Qwen 개선 후보. 사진을 클릭하면 저장된 전체 이미지를 열 수 있습니다. AI를 다시 실행하거나 외부에 사진을 보내지 않습니다.</p><p class="muted">생성 ${escapeHtml(snapshot.generatedAt)} · 코드 ${escapeHtml(snapshot.codeHash ?? '혼합 또는 없음')}<br>정답 동결 ${escapeHtml(snapshot.manifestHash)}</p>${snapshot.issues.length ? `<div class="warning"><strong>합계 검토 필요</strong><ul>${snapshot.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div>` : ''}${summaryTables(summary)}<p><a href="summary.json">전체 집계 JSON</a> · <a href="manifest.json">고정 주석과 출처</a></p><details><summary>환경·측정 범위</summary><pre>${escapeHtml(JSON.stringify(snapshot.environments, null, 2))}</pre></details></section><div class="filters"><label>분할 <select id="split"><option value="all">전체</option><option value="development">개발</option><option value="heldout">최종 평가</option></select></label><label>실행 상태 <select id="status"><option value="all">전체</option><option value="complete">두 엔진 완료</option><option value="failed">실패 포함</option><option value="not-run">미실행 / 진행 중</option></select></label><label>사진 찾기 <input id="query" type="search" placeholder="ID 또는 사진 이름"></label><span id="visible-count" aria-live="polite"></span></div>${cards}<p class="footer-note">고정 정답 ${snapshot.totalCases}장 / 개발 ${snapshot.cases.filter((item) => item.entry.split === 'development').length}장·최종 평가 ${snapshot.cases.filter((item) => item.entry.split === 'heldout').length}장. 알려진 범위와 실패를 분리한 평가이며 종합 정확도나 자동 채택 판정을 만들지 않습니다. 각 사진의 저작권과 라이선스는 공식 출처를 확인하세요.</p></main><script>
const controls=['split','status','query'].map(id=>document.getElementById(id));function update(){const [split,status,query]=controls;let count=0;for(const card of document.querySelectorAll('.case')){const shown=(split.value==='all'||card.dataset.split===split.value)&&(status.value==='all'||card.dataset.status===status.value)&&card.dataset.search.includes(query.value.toLowerCase());card.hidden=!shown;if(shown)count++;}document.getElementById('visible-count').textContent=count+'장 표시';}for(const control of controls)control.addEventListener('input',update);update();
</script></body></html>`;
}

export async function writeCorpusReport(snapshot, manifestBytes, directory) {
  const reportDirectory = path.join(directory, 'report');
  const assets = path.join(reportDirectory, 'assets');
  await fs.mkdir(assets, { recursive: true });
  for (const record of snapshot.cases) {
    await fs.copyFile(record.original, path.join(assets, `${record.entry.id}-original.jpg`));
    for (const engine of ['baseline', 'candidate']) {
      const item = record.engines[engine];
      if (item.png) await fs.copyFile(item.png, path.join(assets, `${record.entry.id}-${engine}.png`));
      if (item.report)
        await fs.writeFile(
          path.join(assets, `${record.entry.id}-${engine}.json`),
          JSON.stringify(item.report, null, 2),
        );
    }
  }
  const summary = corpusSummary(snapshot);
  await fs.writeFile(path.join(reportDirectory, 'manifest.json'), manifestBytes);
  await fs.writeFile(path.join(reportDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(reportDirectory, 'index.html'), renderCorpusHtml(snapshot, summary));
  return {
    directory: reportDirectory,
    html: path.join(reportDirectory, 'index.html'),
    json: path.join(reportDirectory, 'summary.json'),
    complete: snapshot.complete,
    aggregationAllowed: snapshot.aggregationAllowed,
    attemptedCases: snapshot.attemptedCases,
    totalCases: snapshot.totalCases,
  };
}
