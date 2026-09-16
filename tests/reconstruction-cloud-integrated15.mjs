/** Real production UI: Cloudflare Gemma + browser geometry. Default: files only; JSON download verification is optional. */
import { chromium, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { resolve, relative, join, extname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const root = process.cwd();
const args = process.argv.slice(2);
const flags = new Set(['execute', 'dry-run', 'help', 'headed', 'continue-on-error']);
const values = new Set([
  'kind',
  'cases',
  'url',
  'room',
  'mode',
  'output',
  'resume',
  'profile',
  'timeout-ms',
  'channel',
  'download-report',
]);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || (!flags.has(key) && !values.has(key)))
    throw Error(`Unknown option: ${args[i]}`);
  if (key in options) throw Error(`Duplicate option: --${key}`);
  options[key] = flags.has(key) ? true : args[++i];
  if (options[key] === undefined || (typeof options[key] === 'string' && options[key].startsWith('--')))
    throw Error(`Missing --${key} value`);
}
if (options.help) {
  console.log(`Usage: node tests/reconstruction-cloud-integrated15.mjs [options]
  (default)                     Verify all 15 photos and source hashes; no browser/server/AI.
  --execute                     Run actual UI; starts no server and installs nothing.
  --kind gemma|full              Default full. Gemma runs inventory-extended only.
  --cases pc-03,remote-05|all     Default all, in manifest order; strictly sequential.
  --url URL                     Default http://127.0.0.1:8787/reconstruction-performance
  --room estimated|control      Default estimated; control is 2400 x 2400 x 2400 mm.
  --mode auto|webgpu|wasm        Default auto; never changes model weights.
  --output DIR                  New empty run directory inside test-results.
  --resume DIR                  Resume same run/config; verify and skip completed cases.
  --profile DIR                 Isolated persistent Chrome profile inside test-results.
  --timeout-ms NUMBER           Per case, default 1200000 (20 minutes).
  --channel chrome|msedge|chromium  Default chrome; installed browsers only.
  --download-report verify|skip  Default verify. Skip preserves DOM JSON/images; download stays unverified.
  --headed                      Show browser (default headless).
  --continue-on-error           Continue ordinary case failures; quota/auth always abort.

Outputs: manifest + source hashes + append-only attempts, exact UI JSON, Before PNG,
original bytes/current original PNG, API request field hashes and raw JSON/model text,
screenshots, browser stages, actual binding-call counts versus cached stages.
Resume uses the app's valid stage cache, without editing or injecting model answers.
The app may evict old stages (currently 64 entries, 24h TTL); reuse is never assumed.
No billing changes, new service, model installation, deployment or automatic retry loop.`);
  process.exit(0);
}
if (options.execute && options['dry-run']) throw Error('Use either --execute or --dry-run');
if (options.output && options.resume) throw Error('Use either --output or --resume');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const insideResults = (path) => {
  const absolute = resolve(path),
    rel = relative(resolve('test-results'), absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw Error('Run/profile must be a child of this workspace test-results directory');
  return absolute;
};
const runDir = insideResults(
  options.resume ||
    options.output ||
    `test-results/reconstruction-browser-cloud/integrated15-${stamp()}-${randomUUID().slice(0, 8)}`,
);
if (!options.resume && (await exists(runDir)))
  throw Error(`Refusing existing output directory: ${runDir}; use --resume`);
const previous = options.resume ? await readJson(join(runDir, 'manifest.json')) : null;
const config = {
  kind: options.kind || previous?.config.kind || 'full',
  cases: options.cases || previous?.config.cases || 'all',
  url: options.url || previous?.config.url || 'http://127.0.0.1:8787/reconstruction-performance',
  room: options.room || previous?.config.room || 'estimated',
  mode: options.mode || previous?.config.mode || 'auto',
  channel: options.channel || previous?.config.channel || 'chrome',
  downloadReport: options['download-report'] || previous?.config.downloadReport || 'verify',
};
if (
  !['gemma', 'full'].includes(config.kind) ||
  !['estimated', 'control'].includes(config.room) ||
  !['auto', 'webgpu', 'wasm'].includes(config.mode) ||
  !['chrome', 'msedge', 'chromium'].includes(config.channel) ||
  !['verify', 'skip'].includes(config.downloadReport)
)
  throw Error('Invalid kind, room, mode, browser channel or download-report mode');
const target = new URL(config.url);
if (
  target.username ||
  target.password ||
  target.search ||
  target.hash ||
  !['http:', 'https:'].includes(target.protocol)
)
  throw Error('Use a target URL without credentials, query or fragment');
if (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
  throw Error('Remote targets require HTTPS');
if (target.pathname === '/') target.pathname = '/reconstruction-performance';
if (target.pathname !== '/reconstruction-performance')
  throw Error('Target must be /reconstruction-performance');
config.url = target.href;
const timeoutMs = Number(options['timeout-ms'] || 1200000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
  throw Error('timeout-ms must be 1000..3600000');
if (previous && JSON.stringify(previous.config) !== JSON.stringify(config))
  throw Error('Resume config differs; create a new run to compare changed conditions');
const profile = insideResults(options.profile || previous?.profile || join(runDir, 'browser-profile'));
if (previous && previous.profile !== profile) throw Error('Resume must use the original isolated profile');
const corpusPath = resolve('test-results/reconstruction-quality-next/fifteen-photo-manifest.json');
const estimatesPath = resolve(
  'test-results/reconstruction-fifteen-rebuild/20260915-start/room-estimates-20260915.json',
);
const corpus = await readJson(corpusPath),
  estimates = await readJson(estimatesPath);
const selected = config.cases === 'all' ? corpus.files.map((file) => file.id) : config.cases.split(',');
if (
  !selected.length ||
  new Set(selected).size !== selected.length ||
  selected.some((id) => !corpus.files.some((file) => file.id === id))
)
  throw Error('Unknown, empty or duplicate photo ID');
const files = corpus.files.filter((file) => selected.includes(file.id));
const inputs = [];
for (const file of files) {
  const bytes = await readFile(file.path);
  if (sha(bytes) !== file.sha256) throw Error(`Original SHA mismatch: ${file.id}`);
  const estimate = estimates.cases.find((item) => item.id === file.id);
  if (!estimate || estimate.sha256 !== file.sha256 || estimate.measured !== false)
    throw Error(`Room-input provenance mismatch: ${file.id}`);
  const dimensions = config.room === 'control' ? corpus.room : estimate.room;
  const metadata = await sharp(bytes).metadata();
  inputs.push({
    ...file,
    verifiedSha256: sha(bytes),
    bytes: bytes.length,
    image: { width: metadata.width, height: metadata.height, format: metadata.format },
    room: dimensions,
    roomMeasured: false,
    roomSource: config.room === 'control' ? corpus.roomSource : estimate.source,
  });
}
async function sourceSnapshot() {
  const paths = [
    'AGENTS.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    'wrangler.jsonc',
    'build/cloudflare-local.ts',
    'tests/reconstruction-cloud-integrated15.mjs',
  ];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.(?:[cm]?[jt]sx?|css|json)$/.test(entry.name)) paths.push(path);
    }
  }
  await collect('src');
  return Promise.all(
    [...new Set(paths)]
      .sort()
      .map(async (path) => ({ path: path.replaceAll('\\', '/'), sha256: sha(await readFile(path)) })),
  );
}
const sources = await sourceSnapshot();
const sourceSha256 = sha(JSON.stringify(sources));
if (previous && previous.sourceSha256 !== sourceSha256)
  throw Error('Source changed since this run; use a new run directory (you may reuse --profile)');
if (
  previous &&
  (previous.corpusSha256 !== sha(await readFile(corpusPath)) ||
    previous.estimatesSha256 !== sha(await readFile(estimatesPath)))
)
  throw Error('Input configuration changed since this run');
await mkdir(runDir, { recursive: true });
const attemptDir = join(runDir, 'attempts', `${stamp()}-${randomUUID().slice(0, 8)}`);
await mkdir(attemptDir, { recursive: true });
const manifest = previous || {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  config,
  profile,
  sourceSha256,
  corpusPath,
  corpusSha256: sha(await readFile(corpusPath)),
  estimatesPath,
  estimatesSha256: sha(await readFile(estimatesPath)),
  inputs,
  sources,
  interpretation: {
    gemmaOnly: 'inventory-extended only; not all cloud observation stages',
    reconstruction: 'production /reconstruction-performance → cloud-browser-v1 → rendered Before',
    room: 'unmeasured test inputs; dimension changes are not recognition gains',
    visualJudgement: 'pending direct original/Before review against the fixed rubric',
    usage: 'SJN reported binding calls, not billed completions or account usage',
    report:
      'report-dom.json is exact production UI text; result.json exists only after a real successful download',
    download:
      config.downloadReport === 'skip'
        ? 'not verified; quality capture only'
        : 'verify browser download against UI JSON bytes',
    resume: 'verified completed cases skipped; app-owned persistent stage cache, never injected responses',
  },
};
if (!previous) await json(join(runDir, 'manifest.json'), manifest);
await json(join(attemptDir, 'source-start.json'), sources);
const git = promisify(execFile);
await writeFile(
  join(attemptDir, 'git-start.txt'),
  await git('git', ['status', '--short'], { cwd: root, windowsHide: true }).then(
    (value) => value.stdout,
    (error) => `Unavailable: ${error.message}`,
  ),
);
const runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  packages: Object.fromEntries(
    await Promise.all(
      ['@playwright/test', 'next', 'vinext', 'sharp', 'onnxruntime-web', '@tensorflow/tfjs-core'].map(
        async (name) => [name, (await readJson(resolve('node_modules', name, 'package.json'))).version],
      ),
    ),
  ),
};
const attempt = {
  startedAt: new Date().toISOString(),
  mode: options.execute ? 'actual-ui' : 'files-only',
  config,
  runtime,
  cases: [],
  network: [],
  pageErrors: [],
  consoleErrors: [],
  blockedRequests: [],
  evidenceErrors: [],
  browserLifecycle: [],
  abort: null,
};
await json(join(attemptDir, 'invocation.json'), attempt);
for (const file of inputs) {
  const dir = join(runDir, 'inputs', file.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'original' + extname(file.path));
  if (await exists(path)) {
    if (sha(await readFile(path)) !== file.sha256) throw Error(`Preserved original mismatch: ${file.id}`);
  } else await writeFile(path, await readFile(file.path), { flag: 'wx' });
}
if (!options.execute) {
  attempt.status = 'files-verified-no-inference';
  attempt.finishedAt = new Date().toISOString();
  attempt.actualBrowserRequests = 0;
  attempt.actualInferenceCalls = 0;
  await json(join(attemptDir, 'invocation.json'), attempt);
  console.log(
    JSON.stringify({
      status: attempt.status,
      cases: inputs.length,
      sourceSha256,
      artifacts: runDir,
      actualInferenceCalls: 0,
    }),
  );
  process.exit(0);
}

const pending = new Set();
const track = (promise) => {
  pending.add(promise);
  void promise
    .catch((error) => attempt.evidenceErrors.push(String(error)))
    .finally(() => pending.delete(promise));
};
const drain = async () => {
  while (pending.size) await Promise.allSettled([...pending]);
};
const safeUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:') return 'blob:' + safeUrl(parsed.pathname);
    return parsed.origin + parsed.pathname;
  } catch {
    return '[unparseable-url]';
  }
};
let context,
  page,
  active,
  apiIndex = 0;
let closingContext = false;
const recordLifecycle = (event, details = {}) => {
  const entry = {
    at: new Date().toISOString(),
    caseId: active?.id,
    event,
    harnessClosingContext: closingContext,
    ...details,
  };
  attempt.browserLifecycle.push(entry);
  track(writeFile(join(attemptDir, 'browser-lifecycle.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' }));
};
const requests = new Map();
const runStatePath = join(runDir, 'state.json');
const state = (await exists(runStatePath)) ? await readJson(runStatePath) : { completed: {} };
const stop = (reason) => {
  attempt.abort ||= { at: new Date().toISOString(), reason };
};
const interrupt = () => stop('process-interrupted');
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
async function saveBlobImage(locator, path) {
  const data = await locator.evaluate(async (img) => {
    const blob = await (await fetch(img.currentSrc || img.src)).blob();
    return {
      type: blob.type,
      data: await new Promise((done, reject) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }),
    };
  });
  const bytes = Buffer.from(data.data, 'base64');
  await writeFile(path, bytes);
  const metadata = await sharp(bytes).metadata();
  return {
    path: relative(runDir, path).replaceAll('\\', '/'),
    sha256: sha(bytes),
    bytes: bytes.length,
    mime: data.type,
    width: metadata.width,
    height: metadata.height,
  };
}
async function captureRequest(request, directory, index) {
  const bytes = request.postDataBuffer();
  const evidence = {
    at: new Date().toISOString(),
    index,
    url: safeUrl(request.url()),
    method: request.method(),
    bodySha256: bytes ? sha(bytes) : null,
    fields: {},
    files: [],
  };
  if (bytes && request.headers()['content-type']?.includes('multipart/form-data')) {
    const form = await new Request('http://localhost/evidence', {
      method: 'POST',
      headers: { 'Content-Type': request.headers()['content-type'] },
      body: bytes,
    }).formData();
    for (const [key, value] of form) {
      if (typeof value === 'string') evidence.fields[key] = value;
      else {
        const fileBytes = Buffer.from(await value.arrayBuffer());
        const name = `api-${String(index).padStart(3, '0')}-${key.replace(/[^a-z0-9_-]/gi, '_')}${value.type === 'image/png' ? '.png' : '.jpg'}`;
        await writeFile(join(directory, name), fileBytes, { flag: 'wx' });
        evidence.files.push({
          field: key,
          path: name,
          mime: value.type,
          bytes: fileBytes.length,
          sha256: sha(fileBytes),
        });
      }
    }
  }
  await json(join(directory, `api-${String(index).padStart(3, '0')}-request.json`), evidence);
  return evidence;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(config.channel === 'chromium' ? {} : { channel: config.channel }),
    headless: !options.headed,
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
    serviceWorkers: 'block',
    args: ['--enable-webgl', '--enable-unsafe-webgpu'],
  });
  context.on('close', () => recordLifecycle('context-close'));
  context.browser()?.on('disconnected', () => recordLifecycle('browser-disconnected'));
  recordLifecycle('context-ready');
  // Permit actual cloud route and installed-model downloads; deny silent local fallback or external writes.
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
    const cloudPost = url.origin === target.origin && url.pathname === '/api/reconstruction/cloud' && write;
    const reason =
      cloudPost && attempt.abort
        ? 'batch-stopped'
        : write && url.origin !== target.origin
          ? 'external-browser-write'
          : url.origin === target.origin &&
              /^\/api\/reconstruction(?:\/|-lab)/.test(url.pathname) &&
              url.pathname !== '/api/reconstruction/cloud'
            ? 'unexpected-analysis-provider'
            : null;
    if (reason) {
      attempt.blockedRequests.push({ at: new Date().toISOString(), url: safeUrl(request.url()), reason });
      stop(reason);
      await route.abort();
    } else await route.continue();
  });
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30000);
  page.on('crash', () => recordLifecycle('page-crash'));
  page.on('close', () => recordLifecycle('page-close'));
  page.on('download', (download) =>
    recordLifecycle('download-started', {
      suggestedFilename: download.suggestedFilename(),
      url: safeUrl(download.url()),
    }),
  );
  page.on('pageerror', (error) =>
    attempt.pageErrors.push({ at: new Date().toISOString(), caseId: active?.id, message: error.message }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      attempt.consoleErrors.push({
        at: new Date().toISOString(),
        caseId: active?.id,
        message: message.text(),
      });
  });
  page.on('request', (request) => {
    const metadata = {
      at: new Date().toISOString(),
      caseId: active?.id,
      url: safeUrl(request.url()),
      method: request.method(),
      type: request.resourceType(),
    };
    attempt.network.push(metadata);
    if (new URL(request.url()).pathname === '/api/reconstruction/cloud' && request.method() === 'POST') {
      const index = ++apiIndex,
        directory = active?.directory || attemptDir;
      const evidence = captureRequest(request, directory, index);
      active?.postIndexes.push(index);
      requests.set(request, { index, directory, caseId: active?.id, evidence, responses: active?.api });
      track(evidence);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/reconstruction/cloud') return;
    const request = response.request(),
      entry = requests.get(request);
    track(
      (async () => {
        const bytes = await response.body();
        let body;
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          body = {};
        }
        if (
          body.code === 'quota_exhausted' ||
          response.status() === 402 ||
          /\b3036\b|quota.*(?:exhaust|exceed)|daily.*(?:limit|quota)/i.test(String(body.error || ''))
        )
          stop('quota_exhausted');
        if ([401, 403].includes(response.status())) stop('authentication_required');
        if (entry) {
          const captured = await entry.evidence;
          const prefix = `api-${String(entry.index).padStart(3, '0')}`;
          await writeFile(join(entry.directory, `${prefix}-response.body`), bytes, { flag: 'wx' });
          const measured = body.measurement || body.diagnostics?.measurement || body.diagnostics || {};
          const measurement = Object.fromEntries(
            [
              'inferenceCalls',
              'inputTokens',
              'outputTokens',
              'requestMs',
              'cacheHit',
              'httpAttempts',
              'unknownAttempts',
            ]
              .filter((key) => measured[key] !== undefined)
              .map((key) => [key, measured[key]]),
          );
          if (body.diagnostics?.inferenceCalls !== undefined)
            measurement.inferenceCalls = body.diagnostics.inferenceCalls;
          const evidence = {
            at: new Date().toISOString(),
            caseId: entry.caseId,
            index: entry.index,
            operation: captured.fields.operation,
            status: response.status(),
            sha256: sha(bytes),
            bytes: bytes.length,
            code: body.code,
            measurement,
            modelId: body.modelId,
            modelRevision: body.modelRevision,
            promptRevision: body.promptRevision,
            outputContract: body.outputContract,
            completion: body.completion,
          };
          await json(join(entry.directory, `${prefix}-response.json`), evidence);
          entry.responses?.push(evidence);
          const rawText = body.rawText || body.diagnostics?.rawText;
          if (typeof rawText === 'string')
            await writeFile(join(entry.directory, `${prefix}-model-raw.txt`), rawText, { flag: 'wx' });
        } else {
          // No cacheScope, credentials, cookies or headers in evidence logs.
          await writeFile(
            join(attemptDir, 'availability.jsonl'),
            JSON.stringify({
              at: new Date().toISOString(),
              status: response.status(),
              available: body.available,
              reason: body.reason || body.error,
              modelId: body.modelId,
              code: body.code,
            }) + '\n',
            { flag: 'a' },
          );
        }
      })(),
    );
  });
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '정밀 분석 성능 테스트' })).toBeVisible();
  attempt.browserVersion = context.browser()?.version() || 'persistent-context';
  attempt.browserEnvironment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    secureContext: isSecureContext,
    webgpuExposed: 'gpu' in navigator,
  }));
  const servedSources = await Promise.all(
    [
      ...new Set(
        await page.locator('script[src]').evaluateAll((scripts) => scripts.map((script) => script.src)),
      ),
    ]
      .filter((url) => new URL(url).origin === target.origin)
      .map(async (url) => {
        const response = await context.request.get(url);
        const bytes = await response.body();
        return { url: safeUrl(url), status: response.status(), bytes: bytes.length, sha256: sha(bytes) };
      }),
  );
  await json(join(attemptDir, 'served-entry-scripts.json'), servedSources);
  for (const file of inputs) {
    if (attempt.abort) break;
    if (state.completed[file.id]) {
      const completed = state.completed[file.id];
      for (const artifact of completed.artifacts)
        if (sha(await readFile(join(runDir, artifact.path))) !== artifact.sha256)
          throw Error(`Completed artifact changed: ${artifact.path}`);
      attempt.cases.push({
        id: file.id,
        status: 'skipped-completed',
        previous: completed.attempt,
        actualInferenceCalls: 0,
        download: completed.download,
        reportArtifact: completed.reportArtifact,
      });
      continue;
    }
    if (sha(JSON.stringify(await sourceSnapshot())) !== sourceSha256)
      throw Error('Local source changed; stopping before next case');
    const directory = join(attemptDir, file.id);
    await mkdir(directory);
    active = { id: file.id, directory, api: [], postIndexes: [] };
    const result = {
      id: file.id,
      startedAt: new Date().toISOString(),
      room: file.room,
      roomMeasured: false,
      artifacts: [],
      stages: [],
      api: active.api,
      postIndexes: active.postIndexes,
    };
    try {
      await page.getByLabel('테스트 종류').selectOption(config.kind);
      if (config.kind !== 'gemma') await page.getByLabel('MoGe 실행 방식').selectOption(config.mode);
      for (const [label, key] of [
        ['가로', 'widthMm'],
        ['깊이', 'depthMm'],
        ['높이', 'heightMm'],
      ])
        await page.getByRole('spinbutton', { name: `${label} (mm)` }).fill(String(file.room[key]));
      await page.getByLabel('테스트할 사진').setInputFiles(file.path);
      await expect(page.getByRole('button', { name: '테스트 실행', exact: true })).toBeEnabled();
      await page.screenshot({ path: join(directory, 'ready.png'), fullPage: true });
      const started = Date.now();
      await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
      let lastStage = '';
      while (true) {
        const status = await page.getByRole('status').innerText();
        if (status !== lastStage) {
          const stage = { at: new Date().toISOString(), elapsedMs: Date.now() - started, text: status };
          result.stages.push(stage);
          lastStage = status;
          await writeFile(join(directory, 'stages.jsonl'), JSON.stringify(stage) + '\n', { flag: 'a' });
          console.log(JSON.stringify({ id: file.id, ...stage }));
        }
        if (status === '분석 완료') break;
        if (status === '분석을 완료하지 못했어요.') throw Error(await page.getByRole('alert').innerText());
        if (attempt.abort || Date.now() - started > timeoutMs) {
          if (await page.getByRole('button', { name: '취소', exact: true }).count())
            await page.getByRole('button', { name: '취소', exact: true }).click();
          throw Error(attempt.abort?.reason || 'case-timeout');
        }
        await page.waitForTimeout(1000);
      }
      result.wallMs = Date.now() - started;
      result.analysisStatus = 'complete';
      // Read the exact JSON rendered by the production UI before triggering its download.
      // A renderer/download failure must not erase already completed analysis evidence.
      const reportText = await page.locator('main details pre').textContent();
      if (!reportText) throw Error('Completed UI did not expose its report JSON');
      const reportBytes = Buffer.from(reportText, 'utf8');
      const report = JSON.parse(reportText);
      const domReportPath = join(directory, 'report-dom.json');
      await writeFile(domReportPath, reportBytes, { flag: 'wx' });
      result.reportSource = 'production UI details/pre textContent';
      result.reportDomSha256 = sha(reportBytes);
      result.reportArtifact = {
        path: relative(runDir, domReportPath).replaceAll('\\', '/'),
        sha256: result.reportDomSha256,
        bytes: reportBytes.length,
        source: 'ui-dom',
      };
      if (report.kind !== config.kind || (config.kind === 'full' && report.profile !== 'cloud-browser-v1'))
        throw Error('Rendered report kind/profile differs');
      result.reportUsage =
        config.kind === 'gemma'
          ? { stages: [{ stage: 'inventory-extended', ...report.measurement }] }
          : report.quality?.cloudUsage;
      const original = await saveBlobImage(
        page.getByAltText('테스트 원본'),
        join(directory, 'current-original.blob'),
      );
      result.artifacts.push(original);
      result.currentOriginal = original;
      await sharp(await readFile(join(runDir, original.path)))
        .png()
        .toFile(join(directory, 'current-original.png'));
      if (config.kind === 'full') {
        if (report.quality?.photoFingerprint !== original.sha256)
          throw Error('Quality fingerprint does not match the actual normalized original');
        const before = await saveBlobImage(page.getByAltText('재구성 Before'), join(directory, 'before.png'));
        if (before.mime !== 'image/png' || before.width < 32 || before.height < 32)
          throw Error('Before blob is not a valid PNG');
        result.artifacts.push(before);
      }
      result.previews = await page.locator('canvas[aria-label$=" preview"]').evaluateAll((canvases) =>
        canvases.map((canvas) => ({
          label: canvas.getAttribute('aria-label'),
          width: canvas.width,
          height: canvas.height,
          png: canvas.toDataURL('image/png').split(',')[1],
        })),
      );
      for (const preview of result.previews) {
        await writeFile(
          join(directory, preview.label.replace(' preview', '') + '.png'),
          Buffer.from(preview.png, 'base64'),
        );
        delete preview.png;
      }
      await page.screenshot({ path: join(directory, 'before-download.png'), fullPage: true });
      await writeFile(join(directory, 'ui-text.txt'), await page.locator('main').innerText());
      result.captureStatus = 'visuals-and-dom-report-preserved';
      if (config.downloadReport === 'skip') {
        result.download = {
          mode: 'skip',
          status: 'skipped-unverified',
          verified: false,
          reportArtifact: result.reportArtifact,
          reason: 'Explicit quality-capture mode; browser download was not attempted or verified.',
        };
        recordLifecycle('download-skipped', { reportPath: result.reportArtifact.path });
        await json(join(directory, 'download-evidence.json'), result.download);
      } else {
        result.download = {
          mode: config.downloadReport,
          verified: false,
          status: 'pending',
          startedAt: new Date().toISOString(),
        };
        recordLifecycle('download-requested');
        let download;
        try {
          [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: '결과 JSON 다운로드' }).click(),
          ]);
          const reportPath = join(directory, 'result.json');
          await download.saveAs(reportPath);
          const downloadedBytes = await readFile(reportPath);
          result.download.sha256 = sha(downloadedBytes);
          result.download.bytes = downloadedBytes.length;
          result.download.matchesDomReport = result.download.sha256 === result.reportDomSha256;
          if (!result.download.matchesDomReport)
            throw Error('Downloaded JSON bytes differ from rendered UI report');
          result.download.status = 'saved-and-matches-dom';
          result.download.verified = true;
          recordLifecycle('download-saved', { sha256: result.download.sha256 });
        } catch (error) {
          result.download.status = 'failed';
          result.download.error = String(error);
          result.download.pageClosed = page.isClosed();
          result.download.browserConnected = context.browser()?.isConnected() ?? null;
          result.download.suggestedFilename = download?.suggestedFilename();
          recordLifecycle('download-failed', { ...result.download });
          throw error;
        } finally {
          result.download.finishedAt = new Date().toISOString();
          await json(join(directory, 'download-evidence.json'), result.download);
        }
      }

      await drain();
      const posts = result.api;
      if (config.kind === 'gemma' && posts.some((entry) => entry.operation !== 'inventory-extended'))
        throw Error('Gemma-only executed an unexpected operation');
      if (attempt.abort) throw Error(attempt.abort.reason);
      if (attempt.evidenceErrors.length) throw Error('Evidence capture failed');
      result.status = 'complete-pending-visual-review';
      result.visualJudgement = 'not performed by harness';
      result.currentOriginal = original;
      await page.screenshot({ path: join(directory, 'complete.png'), fullPage: true });
      await writeFile(join(directory, 'ui-text.txt'), await page.locator('main').innerText());
      // Pin every capture, including stage responses, rather than only the finished PNG.
      result.artifacts = await Promise.all(
        (await readdir(directory)).map(async (name) => {
          const path = join(directory, name),
            bytes = await readFile(path);
          return {
            path: relative(runDir, path).replaceAll('\\', '/'),
            sha256: sha(bytes),
            bytes: bytes.length,
          };
        }),
      );
      state.completed[file.id] = {
        attempt: relative(runDir, directory).replaceAll('\\', '/'),
        artifacts: result.artifacts,
        completedAt: new Date().toISOString(),
        download: result.download,
        reportArtifact: result.reportArtifact,
      };
      await json(runStatePath, state);
    } catch (error) {
      result.status = 'failed';
      result.error = String(error);
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch((failure) => {
        result.failureScreenshotError = String(failure);
      });
      if (
        await page
          .getByRole('button', { name: '취소', exact: true })
          .count()
          .catch(() => 0)
      )
        await page
          .getByRole('button', { name: '취소', exact: true })
          .click()
          .catch(() => {});
      if (!options['continue-on-error']) stop('case-failed');
      process.exitCode = 1;
    } finally {
      await drain();
      // Failed downloads still retain and hash every artifact captured before the failure.
      result.artifacts = await Promise.all(
        (await readdir(directory))
          .filter((name) => name !== 'evidence.json')
          .map(async (name) => {
            const path = join(directory, name),
              bytes = await readFile(path);
            return {
              path: relative(runDir, path).replaceAll('\\', '/'),
              sha256: sha(bytes),
              bytes: bytes.length,
            };
          }),
      );
      const posts = result.api;
      result.actualUsage = {
        scope: 'observed HTTP POSTs; SJN binding-call counts, not billed completion',
        httpPosts: result.postIndexes.length,
        httpResponses: posts.length,
        knownBindingCalls: posts.reduce(
          (sum, entry) =>
            sum +
            (Number.isInteger(entry.measurement?.inferenceCalls) ? entry.measurement.inferenceCalls : 0),
          0,
        ),
        unknownCallCountPosts:
          result.postIndexes.length -
          posts.length +
          posts.filter((entry) => !Number.isInteger(entry.measurement?.inferenceCalls)).length,
        cachedStages:
          result.reportUsage?.stages
            ?.filter((stage) => stage.cacheHit === true)
            .map((stage) => stage.stage) || [],
      };
      result.finishedAt = new Date().toISOString();
      result.sourceUnchanged = sha(JSON.stringify(await sourceSnapshot())) === sourceSha256;
      if (!result.sourceUnchanged) {
        stop('source-changed');
        delete state.completed[file.id];
        await json(runStatePath, state);
      }
      if (sha(await readFile(file.path)) !== file.sha256) stop('original-changed');
      await json(join(directory, 'evidence.json'), result);
      attempt.cases.push(result);
      await json(join(attemptDir, 'invocation.json'), attempt);
      console.log(
        JSON.stringify({
          id: result.id,
          status: result.status,
          usage: result.actualUsage,
          error: result.error,
        }),
      );
      active = null;
    }
  }
} catch (error) {
  attempt.failure = String(error);
  stop('harness-failed');
  process.exitCode = 1;
} finally {
  await drain();
  closingContext = true;
  recordLifecycle('harness-context-close-requested');
  await context?.close().catch((error) => attempt.evidenceErrors.push(String(error)));
  await drain();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  attempt.finishedAt = new Date().toISOString();
  attempt.status =
    attempt.abort || attempt.cases.some((entry) => entry.status === 'failed')
      ? 'incomplete'
      : 'complete-pending-visual-review';
  if (attempt.status === 'incomplete') process.exitCode = 1;
  attempt.downloadVerification = {
    mode: config.downloadReport,
    verifiedCases: attempt.cases.filter((entry) => entry.download?.verified === true).length,
    skippedCases: attempt.cases.filter((entry) => entry.download?.status === 'skipped-unverified').length,
    failedCases: attempt.cases.filter((entry) => entry.download?.status === 'failed').length,
  };
  attempt.selectedCases = inputs.length;
  attempt.completedCases = attempt.cases.filter((entry) => entry.status !== 'failed').length;
  attempt.measurementScope =
    'Browser/UI timers and provider-reported counters only; RAM/VRAM peaks and billable charges are not measured.';
  await json(join(attemptDir, 'invocation.json'), attempt);
  await json(join(attemptDir, 'source-end.json'), await sourceSnapshot());
  console.log(
    JSON.stringify({ status: attempt.status, abort: attempt.abort, artifacts: runDir, attempt: attemptDir }),
  );
}
