import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloudBrowserQuality } from '../src/lib/reconstruction/cloud-quality';
import { runQualityPipeline, type QualityRunInput } from '../src/lib/reconstruction/quality-core';
import {
  analyzeExtendedScene,
  analyzeReflectionRechecks,
  analyzeShowerInstallations,
} from '../src/lib/reconstruction/analysis-client';
import type { LocalModelMeasurement } from '../src/lib/reconstruction/lab-engine';
vi.mock('../src/lib/reconstruction/quality-core', () => ({ runQualityPipeline: vi.fn() }));
vi.mock('../src/lib/reconstruction/analysis-client', () => ({
  analyzeExtendedScene: vi.fn(),
  analyzeIdentity: vi.fn(),
  analyzeInstallation: vi.fn(),
  analyzeLayout: vi.fn(),
  analyzeFixtureAppearance: vi.fn(),
  analyzeShowerDetails: vi.fn(),
  analyzeDividerMaterials: vi.fn(),
  analyzeReflectionRechecks: vi.fn(),
  analyzeShowerInstallations: vi.fn(),
}));
const measurement = {
  requestMs: 1,
  inferenceCalls: 1,
  httpAttempts: 1,
  inputTokens: 100,
  outputTokens: 20,
} as LocalModelMeasurement;
beforeEach(() => vi.clearAllMocks());
describe('partial cloud run accounting (mock inference)', () => {
  it('checkpoints earlier calls even when a later reflection target fails', async () => {
    const checkpoints: unknown[] = [];
    const input = {
      photo: new Blob(['photo']),
      signal: new AbortController().signal,
      onCheckpoint: (name: string, value: unknown) => {
        if (name === 'cloudUsage') checkpoints.push(value);
      },
    } as QualityRunInput;
    vi.mocked(analyzeExtendedScene).mockResolvedValue({ measurement } as Awaited<
      ReturnType<typeof analyzeExtendedScene>
    >);
    vi.mocked(analyzeReflectionRechecks).mockImplementation(
      async (_photo, _context, _signal, _revision, _provider, report) => {
        report?.('completed-first-target', measurement);
        throw Object.assign(new Error('second target unavailable'), {
          diagnostics: { inferenceCalls: 1, httpAttempts: 1 },
        });
      },
    );
    vi.mocked(runQualityPipeline).mockImplementation(async (current, dependencies) => {
      if (!dependencies) throw new Error('Cloud dependencies were not supplied');
      await dependencies.inventory(current.photo, current.signal);
      await dependencies.reflectionRecheck!(current.photo, {} as never, current.signal, 'provider-managed');
      throw new Error('unreachable');
    });
    await expect(runCloudBrowserQuality(input)).rejects.toMatchObject({
      diagnostics: { cloudUsage: { inferenceCalls: 3 } },
    });
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[2]).toMatchObject({
      inferenceCalls: 3,
      knownInputTokens: 200,
      knownOutputTokens: 40,
      unknownTokenStages: 1,
    });
  });
});

describe('cloud shower installedness adapter (mock calls only)', () => {
  it.each([false, true])('enables the new stage and counts each target once (cached=%s)', async (cached) => {
    const checkpoints: unknown[] = [];
    const input = {
      photo: new Blob(['mock photo']),
      signal: new AbortController().signal,
      onCheckpoint: (name: string, value: unknown) => {
        if (name === 'cloudUsage') checkpoints.push(value);
      },
    } as QualityRunInput;
    const measured = { ...measurement, cacheHit: cached };
    vi.mocked(analyzeShowerInstallations).mockImplementation(
      async (_photo, _context, _signal, _revision, report) => {
        report?.('shower-1', measured);
        report?.('shower-2', measured);
        return {
          measurements: [
            { candidateId: 'shower-1', measurement: measured },
            { candidateId: 'shower-2', measurement: measured },
          ],
          record: {},
        } as Awaited<ReturnType<typeof analyzeShowerInstallations>>;
      },
    );
    vi.mocked(runQualityPipeline).mockImplementation(async (current, dependencies) => {
      expect(current).toMatchObject({
        profile: 'cloud-browser-v1',
        estimatedLayout: true,
        refineShowerInstallation: true,
      });
      await dependencies!.showerInstallation!(current.photo, {} as never, current.signal, 'provider-managed');
      return { evidence: {} } as Awaited<ReturnType<typeof runQualityPipeline>>;
    });
    const result = await runCloudBrowserQuality(input);
    expect(result.evidence.cloudUsage).toMatchObject({
      inferenceCalls: cached ? 0 : 2,
      cachedStages: cached ? 2 : 0,
      knownInputTokens: cached ? 0 : 200,
      knownOutputTokens: cached ? 0 : 40,
    });
    expect(result.evidence.cloudUsage?.stages.map((value) => value.stage)).toEqual([
      'showerInstallation:shower-1',
      'showerInstallation:shower-2',
    ]);
    expect(checkpoints).toHaveLength(2);
    expect(analyzeShowerInstallations).toHaveBeenCalledOnce();
  });
  it('retains the completed target count when the next target errors and does not fall back', async () => {
    const input = {
      photo: new Blob(['mock photo']),
      signal: new AbortController().signal,
    } as QualityRunInput;
    vi.mocked(analyzeShowerInstallations).mockImplementation(
      async (_photo, _context, _signal, _revision, report) => {
        report?.('first-target', measurement);
        throw Object.assign(new Error('installedness target failed'), {
          diagnostics: { inferenceCalls: 1, httpAttempts: 1 },
        });
      },
    );
    vi.mocked(runQualityPipeline).mockImplementation(async (current, dependencies) => {
      await dependencies!.showerInstallation!(current.photo, {} as never, current.signal, 'provider-managed');
      throw new Error('unreachable');
    });
    await expect(runCloudBrowserQuality(input)).rejects.toMatchObject({
      diagnostics: { cloudUsage: { inferenceCalls: 2 } },
    });
    expect(analyzeShowerInstallations).toHaveBeenCalledOnce();
  });
});
