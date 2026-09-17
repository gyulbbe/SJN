import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../src/lib/repositories/contracts';
import type { ImageAssetRecord } from '../src/lib/types';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { comparisonFrameError, projectFrameError } from '../src/lib/comparison';

const hooks = vi.hoisted(() => ({
  background: vi.fn(),
  importImage: vi.fn(),
  segment: vi.fn(),
  quality: vi.fn(),
  repositories: vi.fn(),
  output: { width: 4096, height: 2731 },
  order: [] as string[],
}));
vi.mock('../src/lib/room-background', () => ({ renderRoomBackground: hooks.background }));
vi.mock('../src/lib/images', () => ({
  importImage: hooks.importImage,
  canvasBlob: vi.fn(),
  makeAsset: vi.fn(),
}));
vi.mock('../src/lib/segmentation', () => ({ segmentRoom: hooks.segment }));
vi.mock('../src/lib/reconstruction/quality-core', () => ({
  runQualityPipeline: hooks.quality,
  photoFingerprint: vi.fn(),
}));
vi.mock('../src/lib/repositories', () => ({
  getRepositories: hooks.repositories,
  getRepositoryUserId: () => '',
}));
import { createReconstructionProject } from '../src/lib/reconstruction/index';
import { prepareReconstructionTargetFrame } from '../src/lib/reconstruction/reconstruction-target-frame';

const emptyReview = (): ReconstructionReview => ({
  version: 2,
  analysis: 'partial',
  warnings: [],
  candidates: [],
  planes: [],
});
function storage() {
  const put = vi.fn(async () => undefined);
  return { put, repositories: { assets: { put } } as unknown as Repositories };
}
const file = () => new File(['photo'], 'room.png', { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.order.length = 0;
  hooks.output = { width: 4096, height: 2731 };
  hooks.background.mockImplementation(async (_room, size?: { width: number; height: number }) => {
    hooks.order.push('background');
    hooks.output = size ? { ...size } : { width: 4096, height: 2731 };
    return { ...hooks.output, blob: new Blob(['background'], { type: 'image/png' }) };
  });
  hooks.importImage.mockImplementation(async (input: File, _kind, assets: Repositories['assets']) => {
    const background = input.name === '비교 공간 배경.png';
    hooks.order.push(background ? 'import-background' : 'import-photo');
    const size = background ? hooks.output : { width: 1200, height: 1000 };
    const make = (kind: 'original' | 'preview'): ImageAssetRecord => ({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: input.name,
      kind,
      mime: input.type,
      size: input.size,
      blob: input,
      ...size,
      createdAt: new Date().toISOString(),
    });
    const original = make('original'),
      preview = make('preview');
    await assets.put(original);
    await assets.put(preview);
    return { original, preview };
  });
});

describe('reanalysis keeps the existing comparison frame', () => {
  it.each([
    { width: 2048, height: 1366 },
    { width: 1600, height: 1067 },
    { width: 4096, height: 2731 },
  ])('keeps $width × $height instead of choosing this GPU default', async (targetFrame) => {
    const repo = storage();
    const transform = vi.fn(async (review: ReconstructionReview) => {
      hooks.order.push('analysis');
      return { review, plans: {} };
    });
    const project = await createReconstructionProject(file(), DEFAULT_ROOM, {
      repositories: repo.repositories,
      externalDiagnostics: true,
      targetFrame,
      reuseAnalysis: emptyReview(),
      transformAnalysis: transform,
    });
    expect(hooks.background).toHaveBeenCalledExactlyOnceWith(DEFAULT_ROOM, targetFrame);
    expect(hooks.order).toEqual(['background', 'import-photo', 'analysis', 'import-background']);
    expect(project.shared.comparison!.before.imageWidth).toBe(targetFrame.width);
    expect(project.shared.comparison!.before.imageHeight).toBe(targetFrame.height);
    expect(project.shared.comparison!.aspect).toBe(targetFrame.width / targetFrame.height);
    const oldAfter = {
      ...project.shared.baseline,
      imageWidth: targetFrame.width,
      imageHeight: targetFrame.height,
    };
    expect(comparisonFrameError(oldAfter, project.shared.comparison!)).toBeNull();
    expect(projectFrameError(project)).toBeNull();
    expect(hooks.quality).not.toHaveBeenCalled();
    expect(hooks.segment).not.toHaveBeenCalled();
  });

  it('keeps default creation and Lab render timing and arguments unchanged', async () => {
    const repo = storage();
    await createReconstructionProject(file(), DEFAULT_ROOM, {
      repositories: repo.repositories,
      externalDiagnostics: true,
      reuseAnalysis: emptyReview(),
      transformAnalysis: async (review) => {
        hooks.order.push('analysis');
        return { review, plans: {} };
      },
    });
    expect(hooks.background).toHaveBeenCalledExactlyOnceWith(DEFAULT_ROOM);
    expect(hooks.order).toEqual(['import-photo', 'analysis', 'background', 'import-background']);
  });

  it('stops on a lower GPU limit before importing assets or calling any analysis', async () => {
    const repo = storage();
    hooks.background.mockResolvedValueOnce({
      width: 2048,
      height: 1366,
      blob: new Blob(['low-resolution background']),
    });
    await expect(
      createReconstructionProject(file(), DEFAULT_ROOM, {
        repositories: repo.repositories,
        externalDiagnostics: true,
        targetFrame: { width: 4096, height: 2731 },
        analysisProfile: 'local-quality-v1',
      }),
    ).rejects.toThrow('4096×2731');
    expect(hooks.importImage).not.toHaveBeenCalled();
    expect(repo.put).not.toHaveBeenCalled();
    expect(hooks.segment).not.toHaveBeenCalled();
    expect(hooks.quality).not.toHaveBeenCalled();
  });

  it('does not start analysis after cancellation while preparing the existing frame', async () => {
    const controller = new AbortController(),
      repo = storage();
    hooks.background.mockImplementationOnce(async () => {
      controller.abort();
      return { width: 2048, height: 1366, blob: new Blob(['background']) };
    });
    await expect(
      createReconstructionProject(file(), DEFAULT_ROOM, {
        repositories: repo.repositories,
        externalDiagnostics: true,
        signal: controller.signal,
        targetFrame: { width: 2048, height: 1366 },
        analysisProfile: 'local-quality-v1',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(hooks.importImage).not.toHaveBeenCalled();
    expect(hooks.quality).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 100 },
    { width: 100.5, height: 100 },
    { width: 100, height: Number.NaN },
    { width: 9000, height: 9000 },
  ])('rejects invalid target dimensions before allocating a renderer', async (frame) => {
    await expect(prepareReconstructionTargetFrame(DEFAULT_ROOM, frame)).rejects.toThrow('화면 크기');
    expect(hooks.background).not.toHaveBeenCalled();
  });
});
