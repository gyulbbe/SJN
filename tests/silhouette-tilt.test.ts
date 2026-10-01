import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { estimateSilhouetteTilt, measureSilhouetteTilt } from '../src/lib/product3d/silhouette-tilt';
import { lineRollAngle } from '../src/lib/product3d/pose';
import { drawPolygons, ellipse, rectangle, roundedRectangle, turnPoints } from './helpers/silhouette-raster';

type Shape = [number, number][][];
const SIZE = 400;
const CENTRE: [number, number] = [200, 200];
/** A tank on a round bowl, like a one-piece toilet seen from the side. */
const toilet = (): Shape => [roundedRectangle(120, 50, 170, 120, 8), roundedRectangle(95, 165, 215, 180, 60)];
/** A wide basin with a faucet. */
const basin = (): Shape => [roundedRectangle(70, 150, 270, 150, 14), rectangle(120, 90, 18, 62)];
/** A rectangular bath. */
const bath = (): Shape => [roundedRectangle(40, 130, 320, 140, 22)];
const turned = (shape: Shape, degrees: number) =>
  drawPolygons(
    shape.map((polygon) => turnPoints(polygon, degrees, CENTRE)),
    SIZE,
  );
const read = (shape: Shape, degrees: number) => {
  const picture = turned(shape, degrees);
  return estimateSilhouetteTilt(picture.alpha, picture.width, picture.height);
};

describe('estimateSilhouetteTilt: the screen roll of the outline from its straight edges', () => {
  it('reads an upright outline as level', () => {
    for (const [name, shape] of [
      ['toilet', toilet()],
      ['basin', basin()],
      ['bath', bath()],
    ] as const) {
      const tilt = read(shape, 0);
      expect(tilt, name).toBeDefined();
      expect(Math.abs(tilt!.degrees), name).toBeLessThan(0.4);
    }
  });

  it('finds the clockwise turn of every shape from −40° to 40° within a degree', () => {
    for (const [name, shape] of [
      ['toilet', toilet()],
      ['basin', basin()],
      ['bath', bath()],
    ] as const)
      for (let degrees = -40; degrees <= 40; degrees += 5) {
        const tilt = read(shape, degrees);
        expect(tilt, `${name} ${degrees}°`).toBeDefined();
        expect(Math.abs(tilt!.degrees - degrees), `${name} ${degrees}°`).toBeLessThan(1);
      }
  });

  it('is clockwise positive: a top edge that runs down to the right is a positive turn', () => {
    // 15° clockwise: the right end of the top edge is lower on the screen.
    const tilt = read(basin(), 15);
    expect(tilt!.degrees).toBeGreaterThan(14);
    expect(tilt!.degrees).toBeLessThan(16);
    expect(read(basin(), -15)!.degrees).toBeLessThan(-14);
  });

  it('never answers beyond ±44°: a half-turn is ambiguous, not a tilt', () => {
    for (const degrees of [-45, 45, 135]) expect(read(basin(), degrees), `${degrees}°`).toBeUndefined();
  });

  it('does not answer for a round outline, however it is drawn', () => {
    const circle = drawPolygons([ellipse(200, 200, 150, 150)], SIZE);
    expect(estimateSilhouetteTilt(circle.alpha, SIZE, SIZE)).toBeUndefined();
    const bigger = drawPolygons([ellipse(200, 200, 90, 90)], SIZE);
    expect(estimateSilhouetteTilt(bigger.alpha, SIZE, SIZE)).toBeUndefined();
  });

  it('does not answer for a square turned 45° (four edges, two answers) or a hexagon (three)', () => {
    expect(read([rectangle(120, 120, 160, 160)], 45)).toBeUndefined();
    const hexagon: [number, number][] = Array.from({ length: 6 }, (_, i) => [
      200 + 150 * Math.cos((i * Math.PI) / 3),
      200 + 150 * Math.sin((i * Math.PI) / 3),
    ]);
    expect(estimateSilhouetteTilt(...unpack(drawPolygons([hexagon], SIZE)))).toBeUndefined();
  });

  it('leaves an upright square alone: it reads level, so nothing is turned', () => {
    const tilt = read([rectangle(120, 120, 160, 160)], 0);
    expect(tilt).toBeDefined();
    expect(Math.abs(tilt!.degrees)).toBeLessThan(0.4);
  });

  it('does not answer for a lumpy outline without a dominant direction', () => {
    // A blob of many short edges in random directions (seeded).
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const blob: [number, number][] = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      const r = 90 + random() * 90;
      return [200 + r * Math.cos(a), 200 + r * Math.sin(a)];
    });
    expect(estimateSilhouetteTilt(...unpack(drawPolygons([blob], SIZE)))).toBeUndefined();
  });

  it('does not answer for a picture with no product, or one that is all product', () => {
    expect(estimateSilhouetteTilt(new Uint8Array(SIZE * SIZE), SIZE, SIZE)).toBeUndefined();
    expect(estimateSilhouetteTilt(new Uint8Array(SIZE * SIZE).fill(255), SIZE, SIZE)).toBeUndefined();
    expect(estimateSilhouetteTilt(new Uint8Array(4), 2, 2)).toBeUndefined();
    expect(estimateSilhouetteTilt(new Uint8Array(10), 100, 100)).toBeUndefined();
  });

  it('ignores the picture border: an outline cut by the edge has no edge there', () => {
    // Rotated basin pushed against the left edge: the cut is not a line of the product.
    const picture = drawPolygons(
      [turnPoints(basin()[0], 20, CENTRE).map(([x, y]) => [x - 70, y] as [number, number])],
      SIZE,
    );
    const tilt = estimateSilhouetteTilt(picture.alpha, SIZE, SIZE);
    expect(tilt).toBeDefined();
    expect(Math.abs(tilt!.degrees - 20)).toBeLessThan(1.5);
  });

  it('measures the numbers the decision rests on', () => {
    const picture = turned(toilet(), 12);
    const measure = measureSilhouetteTilt(picture.alpha, SIZE, SIZE)!;
    expect(measure.lineShare).toBeGreaterThan(0.1);
    expect(measure.peakShare).toBeGreaterThan(0.5);
    expect(measure.dominance).toBeGreaterThan(1.6);
  });

  it('reads a bigger picture the same as a small one', () => {
    const small = drawPolygons(
      basin().map((polygon) => turnPoints(polygon, 18, CENTRE)),
      SIZE,
    );
    const scale = 2;
    const big = new Uint8Array(SIZE * scale * SIZE * scale);
    for (let y = 0; y < SIZE * scale; y++)
      for (let x = 0; x < SIZE * scale; x++)
        big[y * SIZE * scale + x] = small.alpha[Math.floor(y / scale) * SIZE + Math.floor(x / scale)];
    const a = estimateSilhouetteTilt(small.alpha, SIZE, SIZE)!;
    const b = estimateSilhouetteTilt(big, SIZE * scale, SIZE * scale)!;
    expect(Math.abs(a.degrees - b.degrees)).toBeLessThan(0.7);
  });
});

function unpack(picture: { alpha: ArrayLike<number>; width: number; height: number }) {
  return [picture.alpha, picture.width, picture.height] as const;
}

describe('estimateSilhouetteTilt on the real product cutouts, turned by known angles', () => {
  const root = 'test-results/product3d-batch';
  const names = [
    '01-shelf',
    '02-smart-toilet',
    '03-bathtub-rect',
    '04-bathtub-scene',
    '05-bathtub-top',
    '06-paper-holder',
    '07-stool',
    '08-mirror',
  ].filter((name) => existsSync(`${root}/${name}/cutout.png`));
  // The cutouts are git-ignored measurements of real photos: without them there is nothing to turn.
  it.skipIf(!names.length)(
    'where it answers, the answer follows the turn from −40° to 40° within 1.5°; round ones stay silent',
    async () => {
      const alphaOf = async (input: string | Buffer) => {
        const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const alpha = new Uint8Array(info.width * info.height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
        return { alpha, width: info.width, height: info.height };
      };
      let answered = 0;
      for (const name of names) {
        const file = `${root}/${name}/cutout.png`;
        const base = await alphaOf(file);
        const baseline = estimateSilhouetteTilt(base.alpha, base.width, base.height);
        if (!baseline) continue;
        answered++;
        for (const degrees of [-40, -25, -10, 10, 25, 40]) {
          const png = await sharp(file)
            .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
          const { alpha, width, height } = await alphaOf(png);
          const tilt = estimateSilhouetteTilt(alpha, width, height);
          // sharp turns clockwise for positive angles, as the estimator reads it.
          if (tilt)
            expect(Math.abs(tilt.degrees - baseline.degrees - degrees), `${name} ${degrees}°`).toBeLessThan(
              1.5,
            );
        }
      }
      expect(answered).toBeGreaterThan(0);
      // The round mirror and the stool give no clear direction.
      for (const name of ['07-stool', '08-mirror'].filter((n) => names.includes(n))) {
        const { alpha, width, height } = await alphaOf(`${root}/${name}/cutout.png`);
        expect(estimateSilhouetteTilt(alpha, width, height), name).toBeUndefined();
      }
    },
    60000,
  );
});

describe('lineRollAngle: the roll that makes a dragged line level or upright', () => {
  const at = (x: number, y: number) => ({ x, y });
  it('turns a line that runs down to the right back counter-clockwise (negative) to level it', () => {
    // 100 px right and 26.8 px down is 15° clockwise.
    const roll = lineRollAngle(at(0, 0), at(100, Math.tan((15 * Math.PI) / 180) * 100), 'level')!;
    expect(roll).toBeCloseTo(-15, 6);
    // The same line dragged the other way round is the same line.
    expect(lineRollAngle(at(100, 26.794919), at(0, 0), 'level')!).toBeCloseTo(-15, 4);
  });
  it('turns a line that runs up to the right clockwise (positive) to level it', () => {
    expect(
      lineRollAngle(at(0, 80), at(120, 80 - Math.tan((20 * Math.PI) / 180) * 120), 'level')!,
    ).toBeCloseTo(20, 6);
  });
  it('makes a leaning line upright: the top to the right turns counter-clockwise', () => {
    // Bottom (0, 100) to top (20, 0): leaning 11.3° clockwise from vertical.
    const roll = lineRollAngle(at(0, 100), at(20, 0), 'upright')!;
    expect(roll).toBeCloseTo(-11.309932, 4);
    expect(lineRollAngle(at(20, 0), at(0, 100), 'upright')!).toBeCloseTo(-11.309932, 4);
    expect(lineRollAngle(at(0, 100), at(-20, 0), 'upright')!).toBeCloseTo(11.309932, 4);
  });
  it('is zero for a line that is already level or upright', () => {
    expect(lineRollAngle(at(0, 50), at(200, 50), 'level')).toBe(0);
    expect(lineRollAngle(at(30, 0), at(30, 200), 'upright')).toBe(0);
  });
  it('gives nothing for a short drag or for a line of the other kind', () => {
    expect(lineRollAngle(at(0, 0), at(10, 3), 'level')).toBeUndefined();
    expect(lineRollAngle(at(0, 0), at(0, 0), 'level')).toBeUndefined();
    // A nearly upright line is not a level one (more than 45° away): it is the other tool.
    expect(lineRollAngle(at(0, 0), at(10, 100), 'level')).toBeUndefined();
    expect(lineRollAngle(at(0, 0), at(100, 10), 'upright')).toBeUndefined();
    expect(lineRollAngle(at(0, 0), at(Number.NaN, 100), 'level')).toBeUndefined();
  });
});
