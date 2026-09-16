import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectCorpusReport,
  corpusSummary,
  renderCorpusHtml,
  writeCorpusReport,
} from './helpers/reconstruction-corpus-report.mjs';

const directories: string[] = [];
const input = Buffer.from('report plumbing test bytes; not an AI image fixture');
const hash = crypto.createHash('sha256').update(input).digest('hex');
const manifestHash = 'fixed-manifest';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sjn-corpus-report-'));
  directories.push(directory);
  await fs.writeFile(path.join(directory, 'input.jpg'), input);
  const entry = (id: string, split: string) => ({
    id,
    split,
    input: { path: 'input.jpg', sha256: hash, width: 100, height: 100 },
    roomMm: { width: 2400, depth: 2400, height: 2400 },
    source: {
      title: '<img src=x onerror=alert(1)>',
      author: 'Photographer & author',
      page: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
    annotation: {
      fixtures: [
        {
          id: id + '-f1',
          kind: 'basin',
          mounting: 'wall',
          installationWall: 'back',
          shape: 'rectangular',
          bounds: [0.1, 0.1, 0.4, 0.4],
        },
      ],
      ignore: [],
      reflections: [],
    },
  });
  const manifest = { cases: [entry('case-1', 'development'), entry('case-2', 'heldout')] };
  await fs.writeFile(
    path.join(directory, 'environment-all.json'),
    JSON.stringify({
      manifestHash,
      codeHash: 'same-code',
      model: { modelId: 'qwen', revision: 'model-rev' },
    }),
  );
  return { directory, manifest };
}
async function writeEngine(directory: string, id: string, engine: string, changes = {}) {
  await fs.mkdir(path.join(directory, id), { recursive: true });
  const candidate = {
    id: 'candidate',
    kind: 'basin',
    bounds: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 },
    mounting: 'wall',
    wall: 'back',
    basinStyle: 'wall',
    shape: 'rectangular',
    reflection: 'physical',
  };
  const report = {
    runId: engine + '-run',
    inputFingerprint: hash,
    room: { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
    engineMetadata: {
      id: engine,
      modelId: engine === 'candidate' ? 'qwen' : 'deeplab',
      modelRevision: engine === 'candidate' ? 'model-rev' : 'base-rev',
      revision: 'implementation',
      settings: { promptRevision: 5 },
    },
    rawSegmentationCandidates: [candidate],
    review: { candidates: [] },
    fixtures: [],
    pipeline:
      engine === 'candidate'
        ? {
            automaticUnderstanding: { candidates: [candidate] },
            understanding: { candidates: [candidate] },
            model: { settings: { temperature: 0.7 } },
            placements: [],
          }
        : undefined,
    ...changes,
  };
  await fs.writeFile(path.join(directory, id, engine + '.json'), JSON.stringify(report));
  await fs.writeFile(
    path.join(directory, id, engine + '.png'),
    Buffer.from('PNG placeholder; report-layout unit fixture only'),
  );
}
async function complete(directory: string, id: string, status: string, changes = {}) {
  await fs.mkdir(path.join(directory, id), { recursive: true });
  await fs.writeFile(
    path.join(directory, id, 'completion.json'),
    JSON.stringify({
      id,
      status,
      manifestHash,
      codeHash: 'same-code',
      inputHash: hash,
      errors: [],
      external: [],
      ...changes,
    }),
  );
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('sjn-corpus-report-')
    )
      throw new Error('Unsafe temporary cleanup target.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

describe('offline comparison report, not AI-quality tests', () => {
  it('lists every manifest photo and marks incomplete runs without final claims', async () => {
    const { directory, manifest } = await fixture();
    const snapshot = await collectCorpusReport(manifest, manifestHash, directory, directory);
    expect(snapshot).toMatchObject({
      complete: false,
      totalCases: 2,
      attemptedCases: 0,
      notRunCases: ['case-1', 'case-2'],
    });
    const html = renderCorpusHtml(snapshot, corpusSummary(snapshot));
    expect(html).toContain('미완료 스냅샷');
    expect(html.match(/class="case"/g)).toHaveLength(2);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('공식 출처');
    expect(html).toContain('미측정');
  });
  it('does not display or count stale candidate JSON after a failed retry', async () => {
    const { directory, manifest } = await fixture();
    await writeEngine(directory, 'case-1', 'baseline');
    await writeEngine(directory, 'case-1', 'candidate');
    await complete(directory, 'case-1', 'candidate-failed', { error: 'Invalid model JSON' });
    const snapshot = await collectCorpusReport(manifest, manifestHash, directory, directory);
    expect(snapshot.cases[0].engines).toMatchObject({
      baseline: { status: 'complete' },
      candidate: { status: 'failed', reason: 'Invalid model JSON' },
    });
    const html = renderCorpusHtml(snapshot, corpusSummary(snapshot));
    expect(html).not.toContain('assets/case-1-candidate.png');
    expect(corpusSummary(snapshot)).toMatchObject({
      state: 'incomplete-do-not-report-as-final',
      summaries: {
        candidate: {
          groups: {
            development: { attemptedCases: 1, completedCases: 0, failedCases: [{ caseId: 'case-1' }] },
          },
        },
      },
    });
  });
  it('does not legitimize partial files without a completion marker', async () => {
    const { directory, manifest } = await fixture();
    await writeEngine(directory, 'case-1', 'baseline');
    const snapshot = await collectCorpusReport(manifest, manifestHash, directory, directory);
    expect(snapshot.cases[0].engines).toMatchObject({
      baseline: { status: 'not-run' },
      candidate: { status: 'not-run' },
    });
  });
  it('blocks mixed code hashes, changed model settings and mismatched frozen input metadata', async () => {
    const { directory, manifest } = await fixture();
    for (const id of ['case-1', 'case-2']) {
      await writeEngine(directory, id, 'baseline');
      await writeEngine(directory, id, 'candidate');
      await complete(directory, id, 'complete');
    }
    await complete(directory, 'case-2', 'complete', { codeHash: 'different-code' });
    const mixed = await collectCorpusReport(manifest, manifestHash, directory, directory);
    expect(mixed.aggregationAllowed).toBe(false);
    expect(corpusSummary(mixed).summaries).toMatchObject({ baseline: null, candidate: null });
    await complete(directory, 'case-2', 'complete');
    await writeEngine(directory, 'case-2', 'candidate', {
      engineMetadata: {
        id: 'candidate',
        modelId: 'qwen',
        modelRevision: 'model-rev',
        revision: 'implementation',
        settings: { promptRevision: 99 },
      },
    });
    expect((await collectCorpusReport(manifest, manifestHash, directory, directory)).aggregationAllowed).toBe(
      false,
    );
    await writeEngine(directory, 'case-2', 'candidate', { inputFingerprint: 'wrong' });
    expect((await collectCorpusReport(manifest, manifestHash, directory, directory)).aggregationAllowed).toBe(
      false,
    );
  });
  it('separates successful and failed final records and writes a fully local package', async () => {
    const { directory, manifest } = await fixture();
    await writeEngine(directory, 'case-1', 'baseline');
    await writeEngine(directory, 'case-1', 'candidate');
    await complete(directory, 'case-1', 'complete');
    await complete(directory, 'case-2', 'failed', { error: 'WebGL failed' });
    const snapshot = await collectCorpusReport(manifest, manifestHash, directory, directory);
    expect(snapshot.complete).toBe(true);
    const output = await writeCorpusReport(snapshot, Buffer.from(JSON.stringify(manifest)), directory);
    expect(await fs.readFile(path.join(output.directory, 'assets/case-1-original.jpg'))).toEqual(input);
    const html = await fs.readFile(output.html, 'utf8');
    expect(html).toContain('전체 케이스의 최종 실행 기록');
    expect(html).toContain('WebGL failed');
    const summary = JSON.parse(await fs.readFile(output.json, 'utf8'));
    expect(summary).toMatchObject({
      state: 'complete',
      summaries: {
        baseline: {
          groups: {
            development: { completedCases: 1 },
            heldout: { completedCases: 0, failedCases: [{ caseId: 'case-2' }] },
          },
        },
        candidate: {
          groups: { development: { completedCases: 1 }, heldout: { failedCases: [{ caseId: 'case-2' }] } },
        },
      },
    });
    expect(html).not.toContain('<script src=');
  });
});
