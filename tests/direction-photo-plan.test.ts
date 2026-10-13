import { describe, expect, it, vi } from 'vitest';
import {
  anchorFromAlpha,
  callNeurons,
  directionJobs,
  planDirections,
  runDirectionJobs,
  runEstimate,
} from '../src/lib/direction-photo/plan';
import { mirrorRgba } from '../src/lib/direction-photo/client';

describe('what a run makes', () => {
  it('turns the 왼쪽 photo over for 오른쪽 when the product is the same on both sides', () => {
    expect(planDirections({ installation: 'floor', symmetric: true })).toEqual({
      made: ['정면', '왼쪽', '뒤'],
      mirrored: ['오른쪽'],
      skipped: [],
    });
    expect(planDirections({ installation: 'embedded', symmetric: false })).toEqual({
      made: ['정면', '왼쪽', '오른쪽', '뒤'],
      mirrored: [],
      skipped: [],
    });
  });

  it('makes no 뒤 for a wall product', () => {
    for (const installation of ['wall', 'suspended'] as const)
      expect(planDirections({ installation, symmetric: false })).toEqual({
        made: ['정면', '왼쪽', '오른쪽'],
        mirrored: [],
        skipped: [{ direction: '뒤', reason: '벽에 거는 제품은 뒤 사진을 만들지 않아요' }],
      });
  });

  it('turns pixels over left to right, and twice gives the picture back', () => {
    const rgba = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    expect([...mirrorRgba(rgba, 3, 2)]).toEqual([
      9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4, 21, 22, 23, 24, 17, 18, 19, 20, 13, 14, 15, 16,
    ]);
    expect([...mirrorRgba(mirrorRgba(rgba, 3, 2), 3, 2)]).toEqual(rgba);
  });

  it('estimates calls and neurons from the tiles (5.37 an input tile, 26.05 an output tile)', () => {
    expect(callNeurons({ width: 496, height: 208 }, 1)).toBeCloseTo(2 * 5.37 + 2 * 26.05, 6);
    expect(callNeurons({ width: 432, height: 496 }, 3)).toBeCloseTo(4 * 5.37 + 4 * 26.05, 6);
    const guides = [
      { width: 496, height: 208 },
      { width: 432, height: 496 },
      { width: 496, height: 208 },
    ];
    expect(runEstimate(guides, 1)).toEqual({ calls: 6, neurons: Math.round(2 * (62.84 + 114.94 + 62.84)) });
  });
});

describe('anchor from the cut-out', () => {
  const alpha = (width: number, height: number, box: [number, number, number, number]) => {
    const data = new Uint8Array(width * height);
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) data[y * width + x] = 255;
    return data;
  };
  it('takes the middle of the bottom edge for a floor product and the centre for a wall product', () => {
    const data = alpha(100, 50, [20, 10, 59, 39]);
    expect(anchorFromAlpha(data, 100, 50, true)).toEqual({ x: 0.4, y: 0.8 });
    expect(anchorFromAlpha(data, 100, 50, false)).toEqual({ x: 0.4, y: 0.5 });
  });
  it('ignores faint pixels and has none for an empty picture', () => {
    const data = alpha(10, 10, [2, 2, 5, 5]);
    data[99] = 40;
    expect(anchorFromAlpha(data, 10, 10, true)).toEqual({ x: 0.4, y: 0.6 });
    expect(anchorFromAlpha(new Uint8Array(100), 10, 10, true)).toBeUndefined();
  });
});

describe('a run of requests', () => {
  const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
  const jobs = directionJobs(
    ['정면', '왼쪽', '뒤'],
    2,
    (() => {
      let seed = 100;
      return () => seed++;
    })(),
  );

  it('gives every direction its candidates, each with its own seed', () => {
    expect(jobs.map((job) => [job.direction, job.candidate, job.seed])).toEqual([
      ['정면', 0, 100],
      ['정면', 1, 101],
      ['왼쪽', 0, 102],
      ['왼쪽', 1, 103],
      ['뒤', 0, 104],
      ['뒤', 1, 105],
    ]);
  });

  it.each([402, 429, 401])('stops sending after a %s and fails the rest with its message', async (status) => {
    const request = vi.fn(async (job: (typeof jobs)[number]) => {
      if (job.seed === 101)
        throw Object.assign(new Error('Cloudflare AI 사용 한도를 모두 사용했어요.'), { status });
      return blob;
    });
    const progress: number[] = [];
    const outcomes = await runDirectionJobs({
      jobs,
      request,
      signal: new AbortController().signal,
      concurrency: 1,
      onProgress: (done) => progress.push(done),
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.status)).toEqual(['made', 'failed', 'failed', 'failed', 'failed', 'failed']);
    expect(outcomes.slice(1).every((o) => o.status === 'failed' && o.message.includes('한도'))).toBe(true);
    expect(outcomes.slice(2).every((o) => o.status === 'failed' && !o.sent)).toBe(true);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps going after any other failure, and never retries', async () => {
    const request = vi.fn(async (job: (typeof jobs)[number]) => {
      if (job.seed === 102)
        throw Object.assign(new Error('AI 이미지 형식이 올바르지 않아요.'), { status: 502 });
      return blob;
    });
    const outcomes = await runDirectionJobs({ jobs, request, signal: new AbortController().signal });
    expect(request).toHaveBeenCalledTimes(6);
    expect(outcomes.filter((o) => o.status === 'failed')).toHaveLength(1);
  });

  it('ends the run when cancelled', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw new DOMException('cancelled', 'AbortError');
    });
    await expect(
      runDirectionJobs({ jobs, request, signal: controller.signal, concurrency: 1 }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
