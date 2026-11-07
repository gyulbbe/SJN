/**
 * The direction-photo methods trial's tools (tests/direction-photo-methods/): the product sets, the
 * methods' requests against the app's own prompt, the trial shapes, the outline score and the budget.
 * No AI call, no browser.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildDirectionPhotoPrompt } from '../src/lib/direction-photo/prompt';
import { callNeurons } from '../src/lib/direction-photo/plan';
import { directionPhotoSpecSchema } from '../src/lib/direction-photo/contract';
import { TOILET_SIDE_ELEVATION } from '../src/lib/direction-photo/categories/toilet';
import { PRODUCTS, productsFor, productById } from './direction-photo-methods/products';
import { B2_NOUNS, jobFor } from './direction-photo-methods/methods';
import { createTrialShape, shapeExtent } from './direction-photo-methods/shapes';
import { budgetCheck, endsRun, fluxCost, ofAccount, type Row } from './direction-photo-methods/budget';
import { parseAccountFile } from './direction-photo-methods/flux-send';
import { iou, outline } from './direction-photo-real/measure.mjs';

const REFS = ['refs/1.png', 'refs/2.png'];

describe('product sets', () => {
  it('holds products out of development: 3 basins and 2 toilets, the bath has none', () => {
    const held = PRODUCTS.filter((p) => p.set === 'holdout');
    expect(held.filter((p) => p.category === 'basin').map((p) => p.id)).toEqual(['b04', 'b09', 'b13']);
    expect(held.filter((p) => p.category === 'toilet')).toHaveLength(2);
    expect(productsFor('dev').some((p) => p.set === 'holdout')).toBe(false);
    expect(productsFor('dev', 'bath')).toHaveLength(1);
  });
  it('makes the directions the app makes: no back for a wall basin, a right side only when not mirrored', () => {
    for (const p of PRODUCTS.filter((p) => p.category === 'basin')) {
      expect(directionPhotoSpecSchema.safeParse({ ...p.spec, direction: 'front' }).success).toBe(true);
      expect(p.views.includes('back')).toBe(p.spec.installation === 'floor');
      expect(p.b2).toBeDefined();
    }
    expect(productById('b06').views).toContain('right');
    expect(productById('b02').views).toEqual(['front', 'left']);
    expect(productById('b10').views).toEqual(['front', 'left', 'back']);
  });
  it('never sends a toilet answer photo: its photos are the cover or the front only', () => {
    for (const p of PRODUCTS.filter((p) => p.category === 'toilet' && p.photos[0].startsWith('catalog:')))
      for (const photo of p.photos) expect(['catalog:cover', 'catalog:front']).toContain(photo);
  });
});

describe('methods start from the app prompt', () => {
  const b02 = productById('b02');
  const spec = (view: 'front' | 'left' | 'back') =>
    directionPhotoSpecSchema.parse({ ...b02.spec, direction: view });
  it('C0 is the app: its guide and its prompt, one photo', () => {
    const job = jobFor(b02, 'left', 'C0', 1001, REFS);
    expect(job.image0).toBe('prep:b0:left');
    expect(job.refs).toEqual(['refs/1.png']);
    expect(job.prompt).toBe(buildDirectionPhotoPrompt(spec('left'), 1));
  });
  it('B2 changes the guide and the product noun only', () => {
    const job = jobFor(b02, 'left', 'B2', 1001, REFS);
    expect(job.image0).toBe('prep:b2:left');
    expect(job.prompt).toBe(
      buildDirectionPhotoPrompt(spec('left'), 1).replace(
        'a wall-hung washbasin with a rectangular bowl',
        B2_NOUNS['vessel-rect'],
      ),
    );
  });
  it('C3 adds the orthographic sentence to sides only', () => {
    expect(jobFor(b02, 'left', 'C3', 1001, REFS).prompt.endsWith(TOILET_SIDE_ELEVATION)).toBe(true);
    expect(() => jobFor(b02, 'front', 'C3', 1001, REFS)).toThrow();
  });
  it('C1 first makes the shape without a photo, then puts that answer in image 0', () => {
    const first = jobFor(b02, 'front', 'C1s1', 1001, REFS);
    expect(first.refs).toEqual([]);
    expect(first.prompt).not.toContain('Image 1');
    const second = jobFor(b02, 'front', 'C1', 1001, REFS);
    expect(second.image0).toBe('run:C1s1:front');
    expect(second.prompt).toContain('Image 0 is a studio photograph of');
  });
  it('B6 makes a toilet near side from its far side mirrored', () => {
    const toilet = productById('t-ark-1p');
    expect(jobFor(toilet, 'right', 'B6', 1001, REFS).image0).toBe('run!:C0:left');
    expect(() => jobFor(toilet, 'left', 'B6', 1001, REFS)).toThrow();
  });
  it('A1 sends the cover and the front photo, telling the second is from the front', () => {
    const job = jobFor(productById('t-ark-1p'), 'left', 'A1', 1001, REFS);
    expect(job.refs).toEqual(REFS);
    expect(job.prompt).toContain('image 2 from straight in front of the product');
  });
});

describe('trial shapes', () => {
  it('fill the registered box exactly, as the standard model does', () => {
    const size: [number, number, number] = [500, 130, 420];
    for (const shape of Object.keys(B2_NOUNS) as (keyof typeof B2_NOUNS)[]) {
      const { min, max } = shapeExtent(createTrialShape(shape, size));
      expect([max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(Math.round), shape).toEqual(size);
      expect(min[1], shape).toBeCloseTo(0, 3);
    }
  });
});

describe('outline score', () => {
  const rect = (w: number, h: number, bw: number, bh: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
      .composite([
        {
          input: { create: { width: bw, height: bh, channels: 3, background: '#808080' } },
          left: Math.round((w - bw) / 2),
          top: Math.round((h - bh) / 2),
        },
      ])
      .png()
      .toBuffer();
  it('compares outlines after cutting each to its box, so the size does not matter', async () => {
    const a = await outline(await rect(400, 300, 200, 100));
    const b = await outline(await rect(800, 600, 400, 200));
    expect(iou(a.mask, b.mask)).toBeCloseTo(1, 2);
    expect(a.aspect).toBeCloseTo(2, 1);
  });
});

describe('budget', () => {
  const at = '2026-11-05T01:00:00.000Z';
  it('estimates a call as the app does', () => {
    expect(fluxCost({ width: 496, height: 224 }, 1)).toBe(callNeurons({ width: 496, height: 224 }, 1));
  });
  it('refuses past the day share counting the other trials of the account, not local or refused calls', () => {
    const own: Row[] = [
      { at, neurons: 4000, status: 200 },
      { at, neurons: 99999, status: 'refused' },
      { at, neurons: 99999, status: 200, engine: 'local' },
    ];
    const others: Row[] = [
      { at, neurons: 4900, status: 200 },
      { at: '2026-11-04T23:00:00.000Z', neurons: 9000, status: 200 },
    ];
    expect(budgetCheck(own, others, { at, cost: 90 }, { budget: 25_000, daily: 9_000 })).toEqual({ ok: true });
    expect(budgetCheck(own, others, { at, cost: 120 }, { budget: 25_000, daily: 9_000 }).ok).toBe(false);
    // The default share since 2026-11-06: 5,000 estimated.
    expect(budgetCheck([{ at, neurons: 4950, status: 200 }], [], { at, cost: 60 }).ok).toBe(false);
  });
  it('refuses past 90% of the trial budget', () => {
    expect(
      budgetCheck([{ at: '2026-11-01T00:00:00.000Z', neurons: 22_450, status: 200 }], [], { at, cost: 60 })
        .ok,
    ).toBe(false);
  });
  it('counts each account on its own day (rows without an account are the signed-in one)', () => {
    const rows: Row[] = [
      { at, neurons: 4900, status: 200 },
      { at, neurons: 100, status: 200, account: 'second' },
    ];
    expect(ofAccount(rows).map((row) => row.neurons)).toEqual([4900]);
    expect(ofAccount(rows, 'second').map((row) => row.neurons)).toEqual([100]);
    expect(budgetCheck(ofAccount(rows, 'second'), [], { at, cost: 3000 }).ok).toBe(true);
    expect(budgetCheck(ofAccount(rows), [], { at, cost: 3000 }).ok).toBe(false);
  });
  it('reads the second account file and refuses a malformed one', () => {
    const id = 'a'.repeat(32);
    const file = (account: string, token: string) =>
      ['# note', `CLOUDFLARE_ACCOUNT_ID=${account}`, `CLOUDFLARE_API_TOKEN=${token}`, ''].join('\n');
    expect(parseAccountFile(file(id, '"tok_1"'))).toEqual({ accountId: id, token: 'tok_1' });
    expect(() => parseAccountFile(file('', 'x'))).toThrow(/ACCOUNT_ID/);
    expect(() => parseAccountFile(file(id, ''))).toThrow(/TOKEN/);
  });
  it('stops the run on the account limit', () => {
    expect(endsRun(429)).toBe(true);
    expect(endsRun(502, '3036: daily free allocation exceeded')).toBe(true);
    expect(endsRun(502, 'timeout')).toBe(false);
  });
});
