import { describe, expect, it } from 'vitest';
import { roundedRectPoints, shapeExtent } from './direction-photo-methods/shapes';
import { buildDirectionPhotoPrompt } from '../src/lib/direction-photo/prompt';
import { appSize, seriesOf } from './sanitary-guides/catalog';
import { CLASSES, directionsOf } from './sanitary-guides/classes';
import { ASYMMETRIC, guideOf, lengthAway, NO_C0, promptFor, specOf, viewsOf } from './sanitary-guides/prompts';
import { createSanitaryShape, SANITARY_SHAPES } from './sanitary-guides/shapes';
import { LEDGER as METHODS_LEDGER } from './direction-photo-methods/paths.mjs';
import { OTHER_LEDGERS } from './sanitary-guides/paths.mjs';

describe('sanitary-ware guide classes', () => {
  it('puts each of the 200 collected products in exactly one class', () => {
    const members = CLASSES.flatMap((c) => c.members);
    expect(members).toHaveLength(200);
    expect(new Set(members).size).toBe(200);
    for (const c of CLASSES) expect(c.members).toContain(c.rep);
  });

  it('gives a floor product a back view and a wall product none', () => {
    for (const c of CLASSES)
      expect((directionsOf(c) as readonly string[]).includes('뒤')).toBe(c.installation !== 'wall');
  });

  it.each(SANITARY_SHAPES)('%s fills its box exactly', (shape) => {
    const size: [number, number, number] = [500, 400, 450];
    const { min, max } = shapeExtent(createSanitaryShape(shape, size));
    for (let k = 0; k < 3; k++) expect(max[k] - min[k]).toBeCloseTo(size[k], 3);
    expect(min[1]).toBeCloseTo(0, 3);
    expect(min[0] + max[0]).toBeCloseTo(0, 3);
    expect(min[2] + max[2]).toBeCloseTo(0, 3);
  });
});

describe('roundedRectPoints', () => {
  it('turns one way all round (its corners bulge out; until 2026-11-06 they turned inward)', () => {
    const points = roundedRectPoints(400, 300, 60, 20, 6);
    const xs = points.map((p) => p[0]),
      zs = points.map((p) => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(200, 6);
    expect(Math.min(...xs)).toBeCloseTo(-200, 6);
    expect(Math.max(...zs)).toBeCloseTo(170, 6);
    expect(Math.min(...zs)).toBeCloseTo(-130, 6);
    const signs = new Set<number>();
    for (let i = 0; i < points.length; i++) {
      const [a, b, c] = [points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) > 1e-6) signs.add(Math.sign(cross));
    }
    expect([...signs]).toHaveLength(1);
  });
});

describe('sanitary-ware AI direction-photo trial (2026-11-07)', () => {
  it('makes the views the app makes: 111 in all, no toilet back, a right side only where the sides differ', () => {
    let n = 0;
    for (const c of CLASSES) {
      const views = viewsOf(c);
      n += views.length;
      expect(views.slice(0, 2)).toEqual(['front', 'left']);
      if (c.category === 'toilet') expect(views).toEqual(['front', 'left', 'right']);
      else expect(views.includes('right')).toBe(ASYMMETRIC.has(c.id));
      if (c.category !== 'toilet') expect(views.includes('back')).toBe(c.installation !== 'wall');
    }
    expect(n).toBe(111);
  });

  it('writes a prompt for every class and view: the app own text for C0 and an app-model class', () => {
    for (const c of CLASSES)
      for (const view of viewsOf(c)) {
        const g = promptFor(c, view, 'G');
        const app = buildDirectionPhotoPrompt(specOf(c, view), 1);
        if (c.model.from === 'app') expect(g).toBe(app);
        else expect(g).not.toBe(app);
        if (NO_C0.has(c.id)) expect(() => promptFor(c, view, 'C0')).toThrow();
        else expect(promptFor(c, view, 'C0')).toBe(app);
        if (c.category === 'urinal') {
          expect(g).not.toContain('washbasin');
          expect(g).toContain('urinal');
        }
        if (c.id === 'T7' || c.id === 'T8') expect(g).not.toMatch(/the tank (is|faces)/);
      }
  });

  it('reads catalogue sizes in the app order', () => {
    expect(appSize('양변기', '690x395x580')).toEqual([395, 580, 690]);
    expect(appSize('세면대', '500x400x150')).toEqual([500, 150, 400]);
    expect(appSize('욕조', '1500x800x600')).toEqual([1500, 600, 800]);
    expect(appSize('세면대', '420x175')).toEqual([420, 175, 420]);
    expect(appSize('세면대', '420x140x17T')).toEqual([420, 140, 420]);
    expect(appSize('세면대', '540X465X820')).toEqual([540, 820, 465]);
    expect(appSize('세면대', '-')).toBeUndefined();
  });

  it('tells the series of a product', () => {
    expect(seriesOf('HSL 302S (상)')).toBe(seriesOf('HSL 302V (하)'));
    expect(seriesOf('HSL 602-1V')).toBe(seriesOf('HSL 602J'));
    expect(seriesOf('그레타 2342 BK')).toBe(seriesOf('그레타 2360 WH'));
    expect(seriesOf('뉴바네스 G63L (L)')).not.toBe(seriesOf('바네스 G62L (L)'));
  });

  it('adds the photo angle and the elevation to a basin, urinal or bath (G2), and leaves a toilet as it is', () => {
    for (const c of CLASSES)
      for (const view of viewsOf(c)) {
        const g = promptFor(c, view, 'G');
        const g2 = promptFor(c, view, 'G2');
        if (c.category === 'toilet') {
          expect(g2).toBe(g);
          continue;
        }
        expect(g2.startsWith(g.slice(0, g.indexOf('Turn image 0 into')))).toBe(true);
        expect(g2).toMatch(view === 'front' ? /do not copy|close to the view|not the view/ : /orthographic (side|back) elevation/);
        if (view !== 'front') expect(g2).toMatch(/orthographic (side|back) elevation[^.]*\.$/);
      }
  });

  it('sends G2 text with the lower guides (G2E0, G2E5) and picks each method its guide', () => {
    const b9 = CLASSES.find((c) => c.id === 'B9')!;
    expect(promptFor(b9, 'left', 'G2E0')).toBe(promptFor(b9, 'left', 'G2'));
    expect(promptFor(b9, 'left', 'G2E5')).toBe(promptFor(b9, 'left', 'G2'));
    expect([guideOf('G'), guideOf('G2'), guideOf('C0'), guideOf('G2E0'), guideOf('G2E5')]).toEqual([
      'G',
      'G',
      'C0',
      'E0',
      'E5',
    ]);
  });

  it('adds the length-away sentence to a side (G2L) with the guide of G', () => {
    const b9 = CLASSES.find((c) => c.id === 'B9')!;
    const g2l = promptFor(b9, 'left', 'G2L', [1200, 200, 460]);
    expect(g2l).toBe(`${promptFor(b9, 'left', 'G2', [1200, 200, 460])} ${lengthAway([1200, 200, 460])}`);
    expect(g2l).toContain('the 1200 mm length runs straight away');
    expect(g2l).toContain('460 mm wide and 200 mm tall');
    expect(guideOf('G2L')).toBe('G');
    expect(() => promptFor(b9, 'front', 'G2L')).toThrow(/side/);
  });

  it('counts the spend of the methods trial toward the day', () => {
    expect(OTHER_LEDGERS).toContain(METHODS_LEDGER);
  });
});
