import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { FLUX_PROMPT_MAX_CHARS } from '../src/lib/ai-export/prompt';
import { admit, BUDGET_STOP, DAILY, type LedgerRow } from './tile-ai/budget';
import { methodLabel, parseMethod } from './tile-ai/methods';
import { restoreJoints } from './tile-ai/restore';
import { faceScores, summary } from './tile-ai/score';
import { tileCountSentence, tileSampleSentence, visibleUnits, type TileFacts } from './tile-ai/sentences';

/** A grey tile picture with lines `at` (shares of the side) across it. */
function tilePicture(width: number, height: number, rows: number[], cols: number[], value = 250) {
  const data = new Uint8Array(width * height).fill(value);
  for (const share of rows) {
    const y = Math.round(share * height);
    for (let x = 0; x < width; x++) data[y * width + x] = value - 40;
  }
  for (const share of cols) {
    const x = Math.round(share * width);
    for (let y = 0; y < height; y++) data[y * width + x] = value - 40;
  }
  return { width, height, data };
}
const facts = (over: Partial<TileFacts['wall']> = {}): TileFacts => ({
  room: { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
  wall: { tileMm: [600, 300], groutMm: 2, pattern: 'grid', units: { cols: 1, rows: 1 }, ...over },
  floor: { tileMm: [600, 600], groutMm: 2, pattern: 'grid', units: { cols: 1, rows: 1 } },
});

describe('the rectangles a tile is scored into', () => {
  it('counts evenly spaced full-length lines', () => {
    expect(visibleUnits(tilePicture(256, 129, [0.2, 0.4, 0.6, 0.8], [0.5]))).toEqual({ cols: 2, rows: 5 });
  });
  it('is 1 × 1 for a plain tile and for lines that do not cut it evenly', () => {
    expect(visibleUnits(tilePicture(256, 128, [], []))).toEqual({ cols: 1, rows: 1 });
    expect(visibleUnits(tilePicture(256, 128, [0.15, 0.7], [0.3]))).toEqual({ cols: 1, rows: 1 });
  });
  it('does not take a short mark for a line', () => {
    const image = tilePicture(256, 128, [], []);
    for (let x = 0; x < 120; x++) image.data[64 * 256 + x] = 200;
    expect(visibleUnits(image)).toEqual({ cols: 1, rows: 1 });
  });
  it('takes the light rim beside a dark line as the same line', () => {
    const image = tilePicture(256, 129, [0.5], []);
    for (let x = 0; x < 256; x++) image.data[(Math.round(0.5 * 129) + 2) * 256 + x] = 255;
    expect(visibleUnits(image).rows).toBe(2);
  });
});

describe('the tile sentences', () => {
  it('names the counts of each face from the room and the tile', () => {
    const sentence = tileCountSentence(facts());
    expect(sentence).toContain('the back wall is about 4 tiles wide and 8 courses high');
    expect(sentence).toContain('the floor is about 4 by 4 tiles');
    expect(sentence).not.toContain('scored');
    expect(sentence).not.toContain('offset');
    expect(tileCountSentence(facts())).toBe(sentence);
  });
  it('adds the bond and the scored rectangles when there are any', () => {
    expect(tileCountSentence(facts({ pattern: 'brick' }))).toContain('offset by half a tile');
    const scored = tileCountSentence(facts({ units: { cols: 2, rows: 5 } }));
    expect(scored).toContain('into 2 × 5 smaller rectangles of about 300 × 60 mm');
    expect(scored).toContain('about 8 columns and 40 thin rows');
  });
  it('has a compact form and stays well inside the prompt', () => {
    const full = tileCountSentence(facts({ pattern: 'brick', units: { cols: 2, rows: 5 } }));
    const compact = tileCountSentence(facts({ pattern: 'brick', units: { cols: 2, rows: 5 } }), true);
    expect(compact.length).toBeLessThan(full.length / 2);
    expect(full.length + tileSampleSentence([902, 611]).length).toBeLessThan(FLUX_PROMPT_MAX_CHARS / 2);
  });
  it('says only numbers about the sample', () => {
    expect(tileSampleSentence([902, 611])).toContain('about 902 × 611 mm of wall');
  });
});

describe('the methods', () => {
  it('reads the parts and refuses what cannot be sent together', () => {
    expect([...parseMethod('cur')]).toEqual([]);
    expect([...parseMethod('grout+units')].sort()).toEqual(['grout', 'units']);
    expect(() => parseMethod('cur+grout')).toThrow();
    expect(() => parseMethod('grout+groutc')).toThrow();
    expect(() => parseMethod('grout+bigin')).toThrow();
    expect(() => parseMethod('grout+grout')).toThrow();
    expect(() => parseMethod('thick')).toThrow();
    expect(methodLabel('grout+units')).toBe('줄눈 굵게 + 타일 수 문장');
  });
});

describe('the budget', () => {
  const row = (neurons: number, at: string, account: LedgerRow['account'] = 'second'): LedgerRow => ({
    at,
    account,
    model: 'm',
    neurons,
    status: 200,
  });
  const now = '2026-11-14T03:00:00.000Z';
  it('refuses past the trial total', () => {
    const rows = [row(BUDGET_STOP - 150, '2026-11-13T10:00:00.000Z', 'third')];
    expect(admit(rows, { at: now, account: 'second', cost: 110 }).ok).toBe(true);
    expect(admit(rows, { at: now, account: 'second', cost: 200 }).ok).toBe(false);
  });
  it("counts another trial's calls of the same account and day against the day only", () => {
    const others = [row(DAILY - 100, '2026-11-14T01:00:00.000Z')];
    expect(admit([], { at: now, account: 'second', cost: 110 }, others).ok).toBe(false);
    expect(admit([], { at: now, account: 'third', cost: 110 }, others).ok).toBe(true);
    expect(admit([], { at: '2026-11-15T00:00:01.000Z', account: 'second', cost: 110 }, others).ok).toBe(true);
  });
});

/** A picture of two faces side by side: a tiled wall (joints every `period`) and a plain floor. */
function room(period: number, fixture = false) {
  const width = 240,
    height = 160;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const wall = y < 110;
      mask[y * width + x] =
        fixture && x > 100 && x < 130 && y > 60 && y < 100 ? FIXTURE_REGION : wall ? 1 : 2;
      const joint = wall && period > 0 && (x % period < 2 || y % period < 2);
      const value = joint ? 150 : wall ? 230 : 190;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  const image: Pixels = { width, height, data };
  const regions: RegionMask = {
    width,
    height,
    regions: [
      { key: 'wall', kind: 'wall' },
      { key: 'floor', kind: 'floor' },
    ],
    data: mask,
  };
  return { image, mask: regions };
}

describe('the joint score', () => {
  it('is high where the joints are kept and low where the wall was re-laid or left plain', () => {
    const reference = room(24);
    const kept = summary(faceScores(reference.image, room(24).image, reference.mask)).wall;
    const relaid = summary(faceScores(reference.image, room(34).image, reference.mask)).wall;
    const plain = summary(faceScores(reference.image, room(0).image, reference.mask)).wall;
    expect(kept).toBeGreaterThan(0.95);
    expect(relaid).toBeLessThan(0.4);
    expect(plain).toBeLessThan(0.1);
  });
  it('allows the small shift a result may have', () => {
    const reference = room(24);
    const shifted = room(24);
    const moved = new Uint8ClampedArray(shifted.image.data.length).fill(255);
    for (let y = 0; y < 160; y++)
      for (let x = 4; x < 240; x++)
        moved.set(
          shifted.image.data.subarray((y * 240 + x - 4) * 4, (y * 240 + x - 4) * 4 + 4),
          (y * 240 + x) * 4,
        );
    const scores = faceScores(reference.image, { ...shifted.image, data: moved }, reference.mask, 4, 0);
    expect(summary(scores).wall).toBeGreaterThan(0.9);
  });
});

describe('putting the joints back', () => {
  it('brings the joints back on the named face and leaves fixtures and other faces alone', () => {
    const reference = room(24, true);
    const result = room(0, true);
    // The model's own light: a slope across the picture.
    for (let i = 0; i < result.image.data.length; i += 4) {
      const x = (i / 4) % 240;
      for (let c = 0; c < 3; c++)
        result.image.data[i + c] = Math.round(result.image.data[i + c] * (0.7 + (0.3 * x) / 240));
    }
    const before = summary(faceScores(reference.image, result.image, reference.mask)).wall;
    const out = restoreJoints(reference.image, result.image, reference.mask, new Set([1]));
    expect(before).toBeLessThan(0.3);
    expect(summary(faceScores(reference.image, out, reference.mask)).wall).toBeGreaterThan(0.8);
    for (let i = 0; i < reference.mask.data.length; i++)
      if (reference.mask.data[i] !== 1)
        expect([out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2]]).toEqual([
          result.image.data[i * 4],
          result.image.data[i * 4 + 1],
          result.image.data[i * 4 + 2],
        ]);
    // The light stays the model's: the wall's left is still darker than its right.
    const mean = (from: number, to: number) => {
      let sum = 0,
        n = 0;
      for (let y = 10; y < 50; y++)
        for (let x = from; x < to; x++) {
          sum += out.data[(y * 240 + x) * 4];
          n++;
        }
      return sum / n;
    };
    expect(mean(10, 40)).toBeLessThan(mean(200, 230) - 20);
  });
  it('changes nothing when no face is named', () => {
    const reference = room(24);
    const result = room(34);
    expect(restoreJoints(reference.image, result.image, reference.mask, new Set()).data).toEqual(
      result.image.data,
    );
  });
});
