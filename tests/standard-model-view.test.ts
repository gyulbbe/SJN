import { describe, expect, it } from 'vitest';
import { refineTargets } from '../src/lib/ai-export/scene';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { normalizeRoomScene } from '../src/lib/room-editing';
import { createQuote } from '../src/lib/quote';
import { fixtureSlotBox } from '../src/lib/room-slot';
import {
  brightHalfColor,
  canShowAsStandardModel,
  isStandardModelOfPhoto,
  showAsPhoto,
  showAsStandardModel,
  standardModelKind,
} from '../src/lib/standard-model-view';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type MaterialCategory,
  type MaterialVersion,
  type Scene,
} from '../src/lib/types';
import type { RoomFace } from '../src/lib/room-types';

const ROOM = DEFAULT_ROOM; // 2400 × 2400 × 2400
const full = { left: 0, top: 0, right: 1, bottom: 1 };

function material(
  category: MaterialCategory,
  patch: Partial<MaterialVersion> = {},
  directions: string[] = ['정면'],
): MaterialVersion {
  return {
    id: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    version: 1,
    name: '제품',
    brand: '',
    code: '',
    category,
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 400,
    heightMm: 700,
    depthMm: 600,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: directions.map((direction) => ({
      assetId: crypto.randomUUID(),
      direction,
      anchor: { x: 0.5, y: 1 },
    })),
    defaultGroutWidth: 0,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: '2026-10-05',
    ...patch,
  };
}
function fixtureOf(
  product: MaterialVersion,
  face: RoomFace,
  u: number,
  v: number,
  patch: Partial<FixtureInstance> = {},
): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: product.name,
    materialVersionId: product.id,
    viewIndex: 0,
    position: { x: 0.5, y: 0.6 },
    width: 0.1,
    height: 0.2,
    rotation: 0,
    anchor: { ...product.views[0].anchor },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face,
      u,
      v,
      scale: 1,
      widthMm: product.widthMm,
      heightMm: product.heightMm,
      imageAspect: product.widthMm / product.heightMm,
      contentBounds: full,
    },
    ...patch,
  };
}
function sceneWith(...fixtures: FixtureInstance[]): Scene {
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...ROOM },
    surfaces: createRoomSurfaces(ROOM, 1.5),
    fixtures,
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
/** The same numbers to 6 decimals: a switch on and off must not move a photo, only rounding may differ. */
const rounded = (value: unknown) =>
  JSON.parse(JSON.stringify(value), (_key, number) =>
    typeof number === 'number' ? Math.round(number * 1e6) / 1e6 : number,
  );
/** What the editor does with a scene change: normalise against the scene before it. */
function edited(previous: Scene, change: (scene: Scene) => void): Scene {
  const next = structuredClone(previous);
  change(next);
  normalizeRoomScene(previous, next);
  return next;
}

describe('the kinds that can be shown as a standard model', () => {
  it('are toilet, basin and bath, and nothing else', () => {
    expect(standardModelKind(material('toilet'))).toBe('toilet');
    expect(standardModelKind(material('basin'))).toBe('basin');
    expect(standardModelKind(material('bath'))).toBe('bath');
    for (const other of ['vanity', 'shower', 'faucet', 'mirror', 'wallCabinet', 'tile'] as const)
      expect(standardModelKind(material(other))).toBeUndefined();
    expect(standardModelKind(undefined)).toBeUndefined();
  });

  it('exclude a product a photo reconstruction made (its material carries the reconstruction mark)', () => {
    const made = material('toilet', { reconstruction: { version: 2, kind: 'toilet' } });
    expect(standardModelKind(made)).toBeUndefined();
    const fixture = fixtureOf(made, 'floor', 0.5, 0.5, {
      reconstruction: {
        version: 2,
        kind: 'toilet',
        color: '#efefea',
        widthMm: 400,
        heightMm: 750,
        depthMm: 680,
      },
    });
    expect(isStandardModelOfPhoto(fixture, made)).toBe(false);
    expect(canShowAsStandardModel(fixture, made)).toBe(false);
    // and it is not touched by the switch either way
    const scene = sceneWith(fixture);
    expect(showAsPhoto(scene, fixture.id, made)).toBe(false);
    expect(scene.fixtures[0].reconstruction).toBeDefined();
  });

  it('are told from a photo product shown as a model by the material, not by the fixture alone', () => {
    const toilet = material('toilet');
    const photo = fixtureOf(toilet, 'floor', 0.5, 0.5);
    expect(canShowAsStandardModel(photo, toilet)).toBe(true);
    expect(isStandardModelOfPhoto(photo, toilet)).toBe(false);
    const scene = sceneWith(photo);
    expect(showAsStandardModel(scene, photo.id, toilet)).toBe(true);
    expect(isStandardModelOfPhoto(scene.fixtures[0], toilet)).toBe(true);
    // already on: no second switch on; without a room placement or a material, none at all
    expect(canShowAsStandardModel(scene.fixtures[0], toilet)).toBe(false);
    expect(canShowAsStandardModel({ ...photo, roomPlacement: undefined }, toilet)).toBe(false);
    expect(canShowAsStandardModel(photo, undefined)).toBe(false);
  });
});

describe('the colour of a product photo', () => {
  const rgba = (...pixels: [number, number, number, number][]) => Uint8ClampedArray.from(pixels.flat());

  it('is the mean of the brighter half of its opaque pixels, shadows and the transparent part left out', () => {
    const data = rgba(
      [240, 240, 240, 255],
      [240, 240, 240, 255],
      [100, 100, 100, 255], // a shadow
      [100, 100, 100, 255],
      [10, 200, 10, 0], // transparent: not counted
    );
    expect(brightHalfColor(data)).toBe('#f0f0f0');
  });

  it('shows what the plain mean would hide: a white product with dark parts is near white', () => {
    const pixels: [number, number, number, number][] = [];
    for (let i = 0; i < 6; i++) pixels.push([236, 236, 232, 255]);
    for (let i = 0; i < 4; i++) pixels.push([60, 60, 64, 255]);
    const mean = Math.round((236 * 6 + 60 * 4) / 10);
    expect(mean).toBeLessThan(170);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(brightHalfColor(rgba(...pixels))!.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(226);
  });

  it('counts the middle brightness level in part, so the half is exact', () => {
    // 4 pixels: two at level 200, two at level 100 → the top half is the two at 200
    expect(
      brightHalfColor(
        rgba([200, 200, 200, 255], [200, 200, 200, 255], [100, 100, 100, 255], [100, 100, 100, 255]),
      ),
    ).toBe('#c8c8c8');
    // 3 pixels at 200, 1 at 100: the top half (2 of 4) is two of the three at 200
    expect(
      brightHalfColor(
        rgba([200, 200, 200, 255], [200, 200, 200, 255], [200, 200, 200, 255], [100, 100, 100, 255]),
      ),
    ).toBe('#c8c8c8');
    // 2 at 200, 2 at 100 plus 1 at 100: 5 pixels, the top 3 are two at 200 and one at 100
    expect(
      brightHalfColor(
        rgba(
          [200, 200, 200, 255],
          [200, 200, 200, 255],
          [100, 100, 100, 255],
          [100, 100, 100, 255],
          [100, 100, 100, 255],
        ),
      ),
    ).toBe('#a7a7a7');
  });

  it('agrees with sorting every pixel by brightness (random photo, within one level)', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pixels: [number, number, number, number][] = [];
    for (let i = 0; i < 4000; i++)
      pixels.push(
        [random() * 255, random() * 255, random() * 255, random() < 0.2 ? 0 : 255].map(Math.floor) as [
          number,
          number,
          number,
          number,
        ],
      );
    const opaque = pixels.filter((p) => p[3] >= 128);
    const luma = (p: number[]) => Math.round(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
    const top = [...opaque]
      .sort((a, b) => luma(a) - luma(b))
      .slice(opaque.length - Math.ceil(opaque.length / 2));
    const expected = [0, 1, 2].map((c) => top.reduce((sum, p) => sum + p[c], 0) / top.length);
    const got = [1, 3, 5].map((i) => parseInt(brightHalfColor(rgba(...pixels))!.slice(i, i + 2), 16));
    got.forEach((value, c) => expect(Math.abs(value - expected[c])).toBeLessThanOrEqual(1.5));
  });

  it('is none for a picture with nothing opaque', () => {
    expect(brightHalfColor(rgba([255, 255, 255, 0]))).toBeUndefined();
    expect(brightHalfColor(new Uint8ClampedArray(0))).toBeUndefined();
  });
});

describe('switching a product to its standard model', () => {
  it('writes the model of a floor toilet: its kind, size, colour, closed lid, base on the floor, facing front', () => {
    const toilet = material('toilet', { widthMm: 370, heightMm: 660, depthMm: 640 });
    const fixture = fixtureOf(toilet, 'floor', 0.28, 0.66);
    const scene = sceneWith(fixture);
    expect(showAsStandardModel(scene, fixture.id, toilet, '#C3C2C4')).toBe(true);
    const after = scene.fixtures[0];
    expect(after.reconstruction).toEqual({
      version: 2,
      kind: 'toilet',
      color: '#c3c2c4',
      widthMm: 370,
      heightMm: 660,
      depthMm: 640,
      baseHeightMm: 0,
      yawDegrees: 0,
      toiletLidState: 'closed',
    });
    // the photo side is untouched
    expect(after.roomPlacement).toEqual(fixture.roomPlacement);
    expect(after.viewIndex).toBe(0);
    expect(after.materialVersionId).toBe(toilet.id);
  });

  it('turns a floor model to where the photo’s angle name looks (오른쪽 +90°, 왼쪽 −90°, 뒤 180°, 위 front)', () => {
    const expected: Record<string, number> = { 정면: 0, 오른쪽: 90, 왼쪽: -90, 뒤: 180, 위: 0, 아래: 0 };
    for (const [name, yaw] of Object.entries(expected)) {
      const bath = material('bath', {}, [name]);
      const fixture = fixtureOf(bath, 'floor', 0.5, 0.3);
      const scene = sceneWith(fixture);
      showAsStandardModel(scene, fixture.id, bath, '#f1f1f1');
      expect(scene.fixtures[0].reconstruction?.yawDegrees, name).toBe(yaw);
    }
  });

  it('keeps a floor product’s u, v and scale, and does not set a bath’s options', () => {
    const bath = material('bath', { widthMm: 1700, heightMm: 560, depthMm: 750 });
    const fixture = fixtureOf(bath, 'floor', 0.5, 0.2);
    const scene = sceneWith(fixture);
    showAsStandardModel(scene, fixture.id, bath, '#f1f1f1');
    const model = scene.fixtures[0].reconstruction!;
    expect(model.kind).toBe('bath');
    expect(model.toiletLidState).toBeUndefined();
    expect(model.basinVariant).toBeUndefined();
    expect([scene.fixtures[0].roomPlacement!.u, scene.fixtures[0].roomPlacement!.v]).toEqual([0.5, 0.2]);
  });

  it('hangs a wall-hung basin where the photo’s lowest point hung, so v follows its lower edge', () => {
    // the photo's anchor is the middle of the content: 560 mm tall, so 280 mm hang below the anchor
    const basin = material('basin', { widthMm: 560, heightMm: 560, depthMm: 440, installation: 'wall' }, [
      '오른쪽',
    ]);
    basin.views[0].anchor = { x: 0.5, y: 0.5 };
    const fixture = fixtureOf(basin, 'left', 0.5, 0.55);
    fixture.anchor = { x: 0.5, y: 0.5 };
    const scene = sceneWith(fixture);
    showAsStandardModel(scene, fixture.id, basin, '#ececee');
    const after = scene.fixtures[0];
    // anchor at (1 − 0.55) × 2400 = 1080 mm; the lowest point 280 mm below: 800 mm
    expect(after.reconstruction?.baseHeightMm).toBeCloseTo(800, 6);
    expect(after.roomPlacement!.v).toBeCloseTo(1 - 800 / 2400, 9);
    expect(after.reconstruction).toMatchObject({
      kind: 'basin',
      basinVariant: 'wall',
      basinShape: 'round',
      bowlCount: 1,
      yawDegrees: 0,
    });
  });

  it('uses a pedestal for a basin that is not installed on a wall, the kind’s usual depth for a missing one, and the material’s colour without a photo colour', () => {
    const basin = material('basin', { installation: 'floor', depthMm: 0, color: '#AABBCC' });
    const fixture = fixtureOf(basin, 'floor', 0.4, 0.5);
    const scene = sceneWith(fixture);
    showAsStandardModel(scene, fixture.id, basin);
    expect(scene.fixtures[0].reconstruction).toMatchObject({
      basinVariant: 'pedestal',
      depthMm: 450,
      color: '#aabbcc',
    });
    // neither: the kind's usual colour
    const plain = material('toilet', { color: '흰색' });
    const other = fixtureOf(plain, 'floor', 0.4, 0.5);
    const second = sceneWith(other);
    showAsStandardModel(second, other.id, plain);
    expect(second.fixtures[0].reconstruction?.color).toBe('#efefea');
  });

  it('does nothing for a kind without a model, a fixture without a placement, a locked-in model or a scene without a room', () => {
    const mirror = material('mirror');
    const a = fixtureOf(mirror, 'back', 0.5, 0.5);
    const scene = sceneWith(a);
    expect(showAsStandardModel(scene, a.id, mirror)).toBe(false);
    const toilet = material('toilet');
    const b = fixtureOf(toilet, 'floor', 0.5, 0.5, { roomPlacement: undefined });
    expect(showAsStandardModel(sceneWith(b), b.id, toilet)).toBe(false);
    const c = fixtureOf(toilet, 'floor', 0.5, 0.5);
    const withoutRoom = sceneWith(c);
    delete withoutRoom.room;
    expect(showAsStandardModel(withoutRoom, c.id, toilet)).toBe(false);
    expect(withoutRoom.fixtures[0].reconstruction).toBeUndefined();
  });
});

describe('switching back to the photo', () => {
  /** A scene as the editor keeps it (every fixture projected), then the fixtures it holds. */
  const settled = (...fixtures: FixtureInstance[]) => {
    const scene = sceneWith(...fixtures);
    normalizeRoomScene(sceneWith(...structuredClone(fixtures)), scene);
    return scene;
  };

  it('takes only the model away: a floor toilet is exactly as it was after on and off, through the editor’s own normalisation', () => {
    const toilet = material('toilet', { widthMm: 370, heightMm: 660, depthMm: 640 });
    const base = settled(fixtureOf(toilet, 'floor', 0.28, 0.66));
    const id = base.fixtures[0].id;
    const on = edited(base, (scene) => void showAsStandardModel(scene, id, toilet, '#c3c2c4'));
    expect(on.fixtures[0].reconstruction).toBeDefined();
    // the model's projection rewrote the 2D box and anchor ...
    expect(on.fixtures[0].anchor).not.toEqual(base.fixtures[0].anchor);
    const off = edited(on, (scene) => void showAsPhoto(scene, id, toilet));
    expect(off.fixtures[0].reconstruction).toBeUndefined();
    // ... and the photo has them back
    expect(rounded(off.fixtures[0])).toEqual(rounded(base.fixtures[0]));
  });

  it('puts a wall basin back where the photo stood (v, anchor, box), through the editor’s own normalisation', () => {
    const basin = material('basin', { widthMm: 560, heightMm: 560, depthMm: 440, installation: 'wall' }, [
      '정면',
      '오른쪽',
    ]);
    basin.views[1].anchor = { x: 0.507, y: 0.488 };
    const photo = fixtureOf(basin, 'left', 0.5, 0.55, { viewIndex: 1, anchor: { x: 0.507, y: 0.488 } });
    photo.roomPlacement!.contentBounds = { left: 0.1, top: 0.15, right: 0.9, bottom: 0.78 };
    const base = settled(photo);
    const id = base.fixtures[0].id;
    const on = edited(base, (scene) => void showAsStandardModel(scene, id, basin, '#ececee'));
    expect(on.fixtures[0].roomPlacement!.v).not.toBeCloseTo(0.55, 3);
    const off = edited(on, (scene) => void showAsPhoto(scene, id, basin));
    expect(rounded(off.fixtures[0])).toEqual(rounded(base.fixtures[0]));
    expect(off.fixtures[0].viewIndex).toBe(1);
  });

  it('follows a moved model: the photo comes back where the model stands now', () => {
    const basin = material('basin', { widthMm: 560, heightMm: 560, depthMm: 440, installation: 'wall' });
    basin.views[0].anchor = { x: 0.5, y: 0.5 };
    const base = settled(fixtureOf(basin, 'back', 0.5, 0.55, { anchor: { x: 0.5, y: 0.5 } }));
    const id = base.fixtures[0].id;
    let scene = edited(base, (s) => void showAsStandardModel(s, id, basin, '#ececee'));
    // the person moves the model 200 mm higher (v is its lower edge)
    scene = edited(scene, (s) => {
      const model = s.fixtures[0];
      model.roomPlacement!.v -= 200 / 2400;
    });
    const baseAfterMove = scene.fixtures[0].reconstruction!.baseHeightMm!;
    expect(baseAfterMove).toBeCloseTo(800 + 200, 3);
    scene = edited(scene, (s) => void showAsPhoto(s, id, basin));
    // the photo's anchor is the content's middle: 280 mm above the lower edge
    expect((1 - scene.fixtures[0].roomPlacement!.v) * 2400).toBeCloseTo(baseAfterMove + 280, 3);
  });

  it('leaves a model a photo reconstruction made, and a fixture with no model, alone', () => {
    const toilet = material('toilet');
    const fixture = fixtureOf(toilet, 'floor', 0.5, 0.5);
    const scene = sceneWith(fixture);
    expect(showAsPhoto(scene, fixture.id, toilet)).toBe(false);
    expect(rounded(scene.fixtures[0])).toEqual(rounded(fixture));
  });
});

describe('where a model stands for the free-place search', () => {
  it('boxes a floor model on its centre, a quarter turn swapping width and depth, and a wall model on its lower edge', () => {
    const bath = material('bath', { widthMm: 1700, heightMm: 560, depthMm: 750 });
    const floor = fixtureOf(bath, 'floor', 0.5, 0.2);
    const scene = sceneWith(floor);
    showAsStandardModel(scene, floor.id, bath, '#f1f1f1');
    const box = fixtureSlotBox(scene.fixtures[0], {})!;
    expect(box).toMatchObject({ widthMm: 1700, depthMm: 750, anchor: { x: 0.5, y: 0.5 } });
    scene.fixtures[0].reconstruction!.yawDegrees = 90;
    expect(fixtureSlotBox(scene.fixtures[0], {})).toMatchObject({ widthMm: 750, depthMm: 1700 });
    const basin = material('basin', { widthMm: 560, heightMm: 560, depthMm: 440, installation: 'wall' });
    const wall = fixtureOf(basin, 'back', 0.5, 0.55);
    const second = sceneWith(wall);
    showAsStandardModel(second, wall.id, basin, '#ececee');
    expect(fixtureSlotBox(second.fixtures[0], {})).toMatchObject({
      widthMm: 560,
      heightMm: 560,
      anchor: { x: 0.5, y: 1 },
    });
  });

  it('boxes a photo product as before (its anchor in the picture decides)', () => {
    const toilet = material('toilet', { depthMm: 640 });
    const fixture = fixtureOf(toilet, 'floor', 0.5, 0.5);
    expect(fixtureSlotBox(fixture, { [toilet.id]: toilet })).toMatchObject({
      widthMm: 400,
      heightMm: 700,
      depthMm: 640,
      anchor: { x: 0.5, y: 1 },
    });
  });
});

describe('the products the AI dialog can repaint', () => {
  const reconstructed = material('toilet', { reconstruction: { version: 2, kind: 'toilet' } });
  const photo = material('toilet');
  const model = {
    version: 2 as const,
    kind: 'toilet',
    color: '#efefea',
    widthMm: 400,
    heightMm: 750,
    depthMm: 680,
  };

  it('mark a switched photo product, so the dialog does not open on the per-product export for it alone', () => {
    const switched = fixtureOf(photo, 'floor', 0.3, 0.5, { reconstruction: model });
    const made = fixtureOf(reconstructed, 'floor', 0.7, 0.5, { reconstruction: model });
    const materials = { [photo.id]: photo, [reconstructed.id]: reconstructed };
    expect(refineTargets({ scene: sceneWith(switched), materials })).toEqual([
      { id: switched.id, fromPhoto: true },
    ]);
    expect(refineTargets({ scene: sceneWith(made), materials })).toEqual([{ id: made.id }]);
    const both = refineTargets({ scene: sceneWith(switched, made), materials });
    expect(both.some((target) => !target.fromPhoto)).toBe(true);
    // a photo product that is not switched is not a target at all
    expect(refineTargets({ scene: sceneWith(fixtureOf(photo, 'floor', 0.5, 0.5)), materials })).toEqual([]);
  });
});

describe('the quote', () => {
  it('counts a product by its material, so showing it as a model changes no line and no signature', () => {
    const toilet = material('toilet', {
      pricing: { unit: 'piece', unitPrice: 150000, boxCoverageM2: null, piecesPerBox: null, wastePercent: 0 },
    });
    const fixture = fixtureOf(toilet, 'floor', 0.4, 0.5);
    const scene = sceneWith(fixture);
    const quoteOf = () =>
      createQuote({ schemaVersion: 2, name: '견적', scene } as never, { [toilet.id]: toilet });
    const lines = (quote: ReturnType<typeof quoteOf>) => quote.lines.map((line) => ({ ...line, id: '' }));
    const before = quoteOf();
    showAsStandardModel(scene, fixture.id, toilet, '#eeeeee');
    const on = quoteOf();
    showAsPhoto(scene, fixture.id, toilet);
    const off = quoteOf();
    expect(on.sourceSignature).toBe(before.sourceSignature);
    expect(off.sourceSignature).toBe(before.sourceSignature);
    expect(lines(on)).toEqual(lines(before));
    expect(lines(off)).toEqual(lines(before));
    expect(before.lines.some((line) => line.category === 'fixture')).toBe(true);
  });
});
