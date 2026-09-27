import { describe, it, expect } from 'vitest';
import {
  compositeFixtures,
  composeFluxResult,
  fixtureGains,
  fixtureLayer,
  floorLineOffset,
  lightGain,
  MAX_GAIN,
  MAX_TINT,
  MIN_GAIN,
  PLACEHOLDER_GREY,
  placeholderRoom,
  resultOnCapture,
  shadowLayer,
  toByte,
  toLinear,
  type RoomLayers,
} from '../src/lib/ai-export/composite';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import type { Pixels, RegionMask } from '../src/lib/ai-export/color';

/**
 * A model answer that is a pure function of where each result pixel sits in the capture: red is
 * the capture x, green the capture y (in 1/4 px steps, 0–255 over the capture), so mapping the
 * answer back must give each capture pixel its own coordinates.
 */
function coordinateAnswer(capture: { width: number; height: number }, factor = 2) {
  const layout = fluxInputLayout(capture.width, capture.height);
  const width = layout.width * factor,
    height = layout.height * factor;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const x = ((u + 0.5) / factor - layout.x) / layout.scale - 0.5,
        y = ((v + 0.5) / factor - layout.y) / layout.scale - 0.5;
      data.set([(x / capture.width) * 255, (y / capture.height) * 255, 0, 255], (v * width + u) * 4);
    }
  return { layout, answer: { width, height, data } as Pixels };
}

describe('the model answer back on the capture grid', () => {
  it.each([
    ['a landscape capture (white padding above and below)', 1024, 683],
    ['a portrait capture (padding left and right)', 600, 1024],
    ['a small capture (scaled up to the 128px minimum)', 100, 67],
  ])('puts every capture pixel back where it was: %s', (_label, width, height) => {
    const { layout, answer } = coordinateAnswer({ width, height });
    const back = resultOnCapture(answer, layout, { width, height });
    let worst = 0;
    for (let y = 2; y < height - 2; y += 3)
      for (let x = 2; x < width - 2; x += 3) {
        const o = (y * width + x) * 4;
        worst = Math.max(
          worst,
          Math.abs(back.data[o] - (x / width) * 255),
          Math.abs(back.data[o + 1] - (y / height) * 255),
        );
      }
    // Within one byte step of the exact coordinate: no offset, no scale error.
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('reads the padding exactly as fluxInputLayout places the capture (496 × 336, 2× answer)', () => {
    const layout = fluxInputLayout(1024, 683);
    expect(layout).toMatchObject({ width: 496, height: 336, x: 0 });
    expect(layout.y).toBeCloseTo((336 - (683 * 496) / 1024) / 2, 6);
    expect(layout.scale).toBeCloseTo(496 / 1024, 9);
  });
});

/** A 40 × 30 room: grey walls, a floor from row 20, one fixture (a square) and its shadow. */
function syntheticLayers(): { layers: RoomLayers; fixture: [number, number, number] } {
  const width = 40,
    height = 30,
    n = width * height;
  const empty = new Uint8ClampedArray(n * 4),
    shadowed = new Uint8ClampedArray(n * 4),
    full = new Uint8ClampedArray(n * 4),
    coverage = new Uint8Array(n);
  const fixture: [number, number, number] = [0.8, 0.78, 0.75];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const room = y >= 20 ? [0.35, 0.34, 0.33] : [0.2, 0.2, 0.19];
      // A shadow to the right of the fixture.
      const shade = x >= 22 && x < 28 && y >= 12 && y < 24 ? 0.6 : 1;
      // The fixture: columns 12–21, rows 10–21, with half-covered edges.
      const inside = x >= 12 && x <= 21 && y >= 10 && y <= 21;
      const edge = inside && (x === 12 || x === 21 || y === 10 || y === 21);
      const a = inside ? (edge ? 0.5 : 1) : 0;
      coverage[i] = Math.round(a * 255);
      for (let c = 0; c < 3; c++) {
        empty[i * 4 + c] = toByte(room[c]);
        shadowed[i * 4 + c] = toByte(toLinear(empty[i * 4 + c]) * shade);
        full[i * 4 + c] = toByte(
          fixture[c] * (coverage[i] / 255) + toLinear(shadowed[i * 4 + c]) * (1 - coverage[i] / 255),
        );
      }
      empty[i * 4 + 3] = shadowed[i * 4 + 3] = full[i * 4 + 3] = 255;
    }
  return { layers: { width, height, full, shadowed, empty, coverage }, fixture };
}

describe('layers', () => {
  it('fixtures over the empty room with their shadow rebuild the render', () => {
    const { layers, fixture } = syntheticLayers();
    const fixtures = fixtureLayer(layers);
    const inner = (13 + 15 * 40) * 3;
    expect([...fixtures.color.slice(inner, inner + 3)].map((v) => +v.toFixed(2))).toEqual(fixture);
    const rebuilt = compositeFixtures({
      room: { width: 40, height: 30, data: layers.empty },
      fixtures,
      shadow: shadowLayer(layers),
    });
    let worst = 0;
    for (let i = 0; i < rebuilt.data.length; i++)
      worst = Math.max(worst, Math.abs(rebuilt.data[i] - layers.full[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('keeps the shadow a darkening only', () => {
    const { layers } = syntheticLayers();
    const shadow = shadowLayer(layers);
    expect(Math.max(...shadow)).toBeLessThanOrEqual(1);
    // 8-bit layers: within a byte step.
    expect(shadow[15 * 40 + 24]).toBeCloseTo(0.6, 1);
    expect(shadow[5 * 40 + 5]).toBe(1);
  });

  it('never moves or resizes a fixture: its pixels follow coverage only, softened one pixel at most', () => {
    const { layers } = syntheticLayers();
    const fixtures = fixtureLayer(layers);
    // A completely different room from the model.
    const room = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4).fill(40) };
    const plain = compositeFixtures({ room, fixtures, shadow: shadowLayer(layers) });
    const soft = compositeFixtures({ room, fixtures, shadow: shadowLayer(layers), feather: true });
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 40; x++) {
        const i = y * 40 + x;
        const far = x < 10 || x > 23 || y < 8 || y > 23;
        // Outside a one-pixel band around the silhouette, the model's room exactly.
        if (far) expect(soft.data[i * 4]).toBe(plain.data[i * 4]);
        // Fully covered interior: the fixture exactly.
        if (x >= 14 && x <= 19 && y >= 12 && y <= 19) {
          expect(plain.data[i * 4]).toBe(layers.full[i * 4]);
          expect(soft.data[i * 4]).toBe(layers.full[i * 4]);
        }
      }
  });

  it('puts grey placeholders only well inside full coverage', () => {
    const { layers } = syntheticLayers();
    const room = placeholderRoom(layers, 2);
    for (let i = 0; i < layers.coverage.length; i++) {
      const grey = room.data[i * 4] === PLACEHOLDER_GREY;
      if (grey) expect(layers.coverage[i]).toBe(255);
      const x = i % 40,
        y = Math.floor(i / 40);
      // 2 px inside the half-covered edge (x 12, 21; y 10, 21).
      expect(grey).toBe(x >= 15 && x <= 18 && y >= 13 && y <= 18);
    }
  });
});

describe('fixture light', () => {
  it('follows the room within limits: never beyond 0.75–1.3, tint at most ±8%', () => {
    const ours = [0.2, 0.2, 0.2].map((v) => v * 100);
    expect(lightGain(ours, ours, 100)).toEqual([1, 1, 1]);
    // The model's room is twice as bright: capped.
    lightGain(
      ours.map((v) => v * 2),
      ours,
      100,
    ).forEach((g) => expect(g).toBeCloseTo(MAX_GAIN, 9));
    lightGain(
      ours.map((v) => v * 0.3),
      ours,
      100,
    ).forEach((g) => expect(g).toBeCloseTo(MIN_GAIN, 9));
    // Much warmer: the tint moves each channel by 8% at most around the luminance gain.
    const warm = lightGain([0.3 * 100, 0.2 * 100, 0.1 * 100], ours, 100);
    const base = (0.2126 * 0.3 + 0.7152 * 0.2 + 0.0722 * 0.1) / 0.2;
    expect(warm[0]).toBeCloseTo(base * (1 + MAX_TINT), 6);
    expect(warm[2]).toBeCloseTo(base * (1 - MAX_TINT), 6);
    // Too few ring pixels: unchanged.
    expect(
      lightGain(
        ours.map((v) => v * 2),
        ours,
        5,
      ),
    ).toEqual([1, 1, 1]);
  });

  it('reads a blurred copy of the same speckled room as the same light', () => {
    // Speckles (dark tile, bright chips) against the model's softened version of them.
    const width = 60,
      height = 40,
      n = width * height;
    const sharp = new Uint8ClampedArray(n * 4),
      blurred = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = (i * 7919) % 11 < 3 ? 220 : 90;
      sharp.set([v, v, v, 255], i * 4);
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += sharp[((i + k + n) % n) * 4];
      blurred.set([s / 5, s / 5, s / 5, 255], i * 4);
    }
    const coverage = new Uint8Array(n);
    for (let y = 15; y < 25; y++) for (let x = 25; x < 35; x++) coverage[y * width + x] = 255;
    const layers: RoomLayers = { width, height, full: sharp, shadowed: sharp, empty: sharp, coverage };
    const mask: RegionMask = {
      width,
      height,
      regions: [{ key: 'face:back', kind: 'wall' }],
      data: new Uint8Array(n).fill(1),
    };
    const [gain] = fixtureGains({
      ai: { width, height, data: blurred },
      layers,
      mask,
      shadow: new Float32Array(n).fill(1),
      boxes: [[25 / 60, 15 / 40, 35 / 60, 25 / 40]],
    });
    gain.gain.forEach((g) => expect(g).toBeCloseTo(1, 2));
  });
});

describe('floor line', () => {
  /** Wall above row `line`, floor below, in both the mask (at `maskLine`) and the model's room. */
  function room(line: number, maskLine: number) {
    const width = 256,
      height = 160;
    const data = new Uint8ClampedArray(width * height * 4);
    const labels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const v = y >= line ? 200 : 110;
        data.set([v, v, v, 255], (y * width + x) * 4);
        labels[y * width + x] = y >= maskLine ? 2 : 1;
      }
    const mask: RegionMask = {
      width,
      height,
      regions: [
        { key: 'face:back', kind: 'wall' },
        { key: 'face:floor', kind: 'floor' },
      ],
      data: labels,
    };
    return { ai: { width, height, data } as Pixels, mask, coverage: new Uint8Array(width * height) };
  }
  it('finds the model floor line where the render has it, and measures a move', () => {
    const same = room(100, 100);
    expect(floorLineOffset(same.ai, same.mask, same.coverage).offset).toBe(0);
    const lower = room(110, 100);
    const found = floorLineOffset(lower.ai, lower.mask, lower.coverage);
    expect(Math.abs(found.offset - 10)).toBeLessThanOrEqual(1);
    expect(found.columns).toBeGreaterThan(50);
  });
});

describe('one composed result', () => {
  it('flags a moved room, not an unchanged one, and keeps the fixture in place either way', () => {
    // A 1024 × 683 frame: wall above row 400, floor below, a fixture square in the middle.
    const width = 1024,
      height = 683,
      n = width * height;
    const empty = new Uint8ClampedArray(n * 4),
      coverage = new Uint8Array(n),
      labels = new Uint8Array(n);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = y >= 400 ? 190 : 100;
        empty.set([v, v, v, 255], i * 4);
        labels[i] = y >= 400 ? 2 : 1;
        if (x >= 480 && x < 560 && y >= 300 && y < 420) {
          coverage[i] = 255;
          labels[i] = 255;
        }
      }
    const full = Uint8ClampedArray.from(empty);
    for (let i = 0; i < n; i++) if (coverage[i]) full.set([240, 238, 236, 255], i * 4);
    const layers: RoomLayers = { width, height, full, shadowed: empty, empty, coverage };
    const mask: RegionMask = {
      width,
      height,
      regions: [
        { key: 'face:back', kind: 'wall' },
        { key: 'face:floor', kind: 'floor' },
      ],
      data: labels,
    };
    const layout = fluxInputLayout(width, height);
    /** The model's answer: the empty room at 2× input size, its floor line moved down `shift` px. */
    const answer = (shift: number): Pixels => {
      const w = layout.width * 2,
        h = layout.height * 2;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let v = 0; v < h; v++)
        for (let u = 0; u < w; u++) {
          const y = ((v + 0.5) / 2 - layout.y) / layout.scale;
          const value = y >= 400 + shift ? 190 : 100;
          data.set([value, value, value, 255], (v * w + u) * 4);
        }
      return { width: w, height: h, data };
    };
    const box: [number, number, number, number] = [480 / width, 300 / height, 560 / width, 420 / height];
    const input = { width, height, data: empty };
    const kept = composeFluxResult({ result: answer(0), input, layers, mask, layout, boxes: [box] });
    const moved = composeFluxResult({ result: answer(14), input, layers, mask, layout, boxes: [box] });
    expect(kept.shifted).toBe(false);
    expect(moved.shifted).toBe(true);
    const o = (360 * width + 520) * 4;
    // Same room light: the render's own pixel.
    expect([...kept.raw.data.slice(o, o + 3)]).toEqual([240, 238, 236]);
    // The moved room is darker around it (wall where the floor was): same place, a little dimmer,
    // never the room's colour.
    const dim = [...moved.raw.data.slice(o, o + 3)];
    dim.forEach((v, c) => expect(v).toBeGreaterThan([240, 238, 236][c] - 16));
    expect(dim[0]).toBeLessThan(240);
  });
});
