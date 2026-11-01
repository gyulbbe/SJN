import { describe, expect, it } from 'vitest';
import { layoutItemSchema, layoutRoomSchema, type LayoutItem } from '../src/lib/fixture-layout-contract';
import {
  keptByLayout,
  layoutBlockedReason,
  layoutItemsFromScene,
  layoutNotes,
  layoutPlaceInRoom,
  layoutPlanShapes,
  layoutView,
  placeLayout,
  type PreparedItem,
} from '../src/lib/fixture-layouts';
import { createPlacedFixture } from '../src/lib/room-fixtures';
import { behindWall, wallDistanceMm } from '../src/lib/room-wall-contact';
import { boxesClose, slotBox } from '../src/lib/room-slot';
import type { RoomDefinition } from '../src/lib/room-types';
import type { FixtureInstance, MaterialVersion } from '../src/lib/types';
import { DEFAULT_COLOR } from '../src/lib/types';

/** 기본 배치's rules (docs/fixture-layouts-results-20261101.md), without a screen. */
const room = (widthMm = 2400, depthMm = 2400, heightMm = 2400): RoomDefinition => ({
  kind: 'parametric',
  version: 1,
  widthMm,
  depthMm,
  heightMm,
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function material(n: number, over: Partial<MaterialVersion> = {}): MaterialVersion {
  return {
    id: uuid(1000 + n),
    materialId: uuid(n),
    version: 1,
    name: `제품 ${n}`,
    brand: '',
    code: '',
    category: 'toilet',
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
    views: [
      { assetId: uuid(2000 + n), direction: '정면', anchor: { x: 0.5, y: 0.95 } },
      { assetId: uuid(3000 + n), direction: '오른쪽', anchor: { x: 0.5, y: 0.95 } },
    ],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: '',
    ...over,
  } as MaterialVersion;
}
const item = (n: number, over: Partial<LayoutItem> = {}): LayoutItem => ({
  materialId: uuid(n),
  face: 'floor',
  u: 0.3,
  v: 0.5,
  scale: 1,
  rotation: 0,
  direction: '정면',
  color: { ...DEFAULT_COLOR },
  shadow: { x: 0, y: 0.005, opacity: 0.3, blur: 0.015, scale: 0.7 },
  ...over,
});
const prepared = (it: LayoutItem, m: MaterialVersion, viewIndex = 0): PreparedItem => ({
  item: it,
  material: m,
  viewIndex,
  imageAspect: 1,
  contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
});
let next = 0;
const place = (input: {
  to?: RoomDefinition;
  from?: RoomDefinition;
  items: PreparedItem[];
  kept?: FixtureInstance[];
  materials?: Record<string, MaterialVersion>;
}) =>
  placeLayout({
    room: input.to ?? room(),
    aspect: 1.5,
    registeredRoom: input.from ?? input.to ?? room(),
    items: input.items,
    kept: input.kept ?? [],
    materials: input.materials ?? {},
    newId: () => uuid(9000 + next++),
  });
const placed = (f: FixtureInstance) => f.roomPlacement!;

describe('같은 방', () => {
  it('자리·방향·회전·크기·색·그림자가 등록한 그대로다', () => {
    const m = material(1);
    const it = item(1, {
      u: 0.21,
      v: 0.33,
      scale: 1.2,
      rotation: 7,
      direction: '오른쪽',
      color: { exposure: 0.1, contrast: 1.1, saturation: 0.9, warmth: 0.2 },
      shadow: { x: 0.01, y: 0.02, opacity: 0.5, blur: 0.1, scale: 0.9 },
    });
    const { fixtures, crowded, tooBig } = place({ items: [prepared(it, m, 1)] });
    expect(crowded).toEqual([]);
    expect(tooBig).toEqual([]);
    const f = fixtures[0]!;
    expect(placed(f)).toMatchObject({ face: 'floor', u: 0.21, v: 0.33, scale: 1.2 });
    expect(f.viewIndex).toBe(1);
    expect(f.rotation).toBe(7);
    expect(f.color).toEqual(it.color);
    expect(f.shadow).toEqual(it.shadow);
    expect(f.locked).toBe(false);
    expect(f.materialVersionId).toBe(m.id);
  });
  it('일부러 겹쳐 등록한 제품(세면대 위 수전)은 비키지 않는다', () => {
    const basin = material(1, { widthMm: 600, heightMm: 300, depthMm: 500 });
    const faucet = material(2, { widthMm: 80, heightMm: 200, depthMm: 100 });
    const { fixtures, crowded } = place({
      to: room(1800, 1800),
      from: room(2400, 2400),
      items: [prepared(item(1, { u: 0.5, v: 0.5 }), basin), prepared(item(2, { u: 0.5, v: 0.5 }), faucet)],
    });
    expect(fixtures.map((f) => [placed(f).u, placed(f).v])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(crowded).toEqual([]);
  });
});

describe('다른 크기의 방', () => {
  it('벽 길이에 비례하고, 벽 제품은 바닥에서 같은 mm 높이다', () => {
    const wall = material(1, { widthMm: 500, heightMm: 300, installation: 'wall' });
    const from = room(2400, 2400, 2400),
      to = room(1800, 1800, 2200);
    const { fixtures } = place({
      from,
      to,
      items: [prepared(item(1, { face: 'back', u: 0.6, v: 0.6 }), wall)],
    });
    const p = placed(fixtures[0]!);
    expect(p.u).toBeCloseTo(0.6);
    expect((1 - p.v) * to.heightMm).toBeCloseTo((1 - 0.6) * from.heightMm);
  });
  it('높이를 유지할 수 없으면 벽 안에 머문다', () => {
    expect(
      layoutPlaceInRoom({ face: 'back', u: 0.5, v: 0 }, room(2400, 2400, 3000), room(2400, 2400, 1000)).v,
    ).toBe(0);
  });
  it('벽 붙임은 그 방의 벽에 제품 깊이만큼 다시 붙는다', () => {
    const m = material(1);
    const to = room(1800, 3000);
    const { fixtures } = place({
      to,
      from: room(),
      items: [prepared(item(1, { u: 0.4, v: 0.125, againstWall: true }), m)],
    });
    const f = fixtures[0]!;
    expect(placed(f).againstWall).toBe(true);
    expect(placed(f).u).toBeCloseTo(0.4);
    expect(wallDistanceMm(to, f, { [m.id]: m })).toBeCloseTo(0);
  });
  it('왼쪽 벽을 등진 변기는 사진 방향으로 그 벽에 붙는다(정면 벽으로 가지 않는다)', () => {
    const m = material(1);
    const to = room(1800, 2000);
    const { fixtures } = place({
      to,
      from: room(),
      items: [prepared(item(1, { u: 0.125, v: 0.5, direction: '오른쪽', againstWall: true }), m, 1)],
    });
    const f = fixtures[0]!;
    expect(behindWall(f, { [m.id]: m })).toBe('left');
    expect(placed(f).v).toBeCloseTo(0.5);
    expect(wallDistanceMm(to, f, { [m.id]: m })).toBeCloseTo(0);
  });
  it('벽을 넘으면 가까운 자리로 비키고, 겹치면 서로 비킨다', () => {
    const a = material(1, { widthMm: 700, depthMm: 700 }),
      b = material(2, { widthMm: 500, depthMm: 500 });
    const to = room(1600, 1600);
    const { fixtures, crowded } = place({
      to,
      from: room(3000, 3000),
      items: [prepared(item(1, { u: 0.1, v: 0.5 }), a), prepared(item(2, { u: 0.4, v: 0.5 }), b)],
    });
    expect(crowded).toEqual([]);
    const boxes = fixtures.map((f, index) => ({
      ...slotBox(placed(f), f.anchor, [a, b][index]!.depthMm),
      u: placed(f).u,
      v: placed(f).v,
    }));
    expect(boxesClose(to, 'floor', boxes[0]!, boxes[1]!)).toBe(false);
    // The first is inside the wall: half its 700 mm width from the left at least.
    expect(placed(fixtures[0]!).u * to.widthMm).toBeGreaterThanOrEqual(349);
  });
  it('벽 제품은 비켜도 높이가 그대로다', () => {
    const a = material(1, { widthMm: 800, heightMm: 300, installation: 'wall' }),
      b = material(2, { widthMm: 800, heightMm: 300, installation: 'wall' });
    const to = room(2000, 2400);
    const { fixtures } = place({
      to,
      from: room(4000, 2400),
      items: [
        prepared(item(1, { face: 'back', u: 0.3, v: 0.6 }), a),
        prepared(item(2, { face: 'back', u: 0.52, v: 0.6 }), b),
      ],
    });
    expect(fixtures.map((f) => placed(f).v)).toEqual([0.6, 0.6]);
    expect(placed(fixtures[0]!).u).not.toBe(placed(fixtures[1]!).u);
  });
  it('자리가 없으면 겹쳐 놓고 알린다', () => {
    const a = material(1, { widthMm: 1200, depthMm: 1200 }),
      b = material(2, { widthMm: 1200, depthMm: 1200 });
    const { fixtures, crowded } = place({
      to: room(1300, 1300),
      from: room(2600, 2600),
      items: [prepared(item(1, { u: 0.25, v: 0.5 }), a), prepared(item(2, { u: 0.75, v: 0.5 }), b)],
    });
    expect(fixtures).toHaveLength(2);
    expect(crowded).toEqual([b.name]);
  });
  it('방보다 큰 제품은 빼고 알린다', () => {
    const big = material(1, { widthMm: 2000 }),
      small = material(2);
    const { fixtures, tooBig } = place({
      to: room(1500, 1500),
      from: room(3000, 3000),
      items: [prepared(item(1), big), prepared(item(2, { u: 0.7 }), small)],
    });
    expect(tooBig).toEqual([big.name]);
    expect(fixtures.map((f) => f.materialVersionId)).toEqual([small.id]);
  });
  it('결과는 늘 같고, 저장 순서는 등록 순서다(큰 제품부터 자리를 잡아도)', () => {
    const small = material(1, { widthMm: 300, depthMm: 300 }),
      big = material(2, { widthMm: 900, depthMm: 900 });
    const input = () => ({
      to: room(1800, 1800),
      from: room(3600, 3600),
      items: [prepared(item(1, { u: 0.2, v: 0.5 }), small), prepared(item(2, { u: 0.4, v: 0.5 }), big)],
    });
    const first = place(input()),
      second = place(input());
    expect(first.fixtures.map(placed)).toEqual(second.fixtures.map(placed));
    expect(first.fixtures.map((f) => f.materialVersionId)).toEqual([small.id, big.id]);
    // Apart where registered, on each other here: the big one keeps its place, the small one moves.
    expect(placed(first.fixtures[1]!).u).toBe(0.4);
    expect([placed(first.fixtures[0]!).u, placed(first.fixtures[0]!).v]).not.toEqual([0.2, 0.5]);
  });
});

describe('잠근 제품과 바꾸기', () => {
  const standing = (over: Partial<FixtureInstance> = {}): FixtureInstance => ({
    ...createPlacedFixture({
      id: uuid(50),
      material: material(5),
      viewIndex: 0,
      view: material(5).views[0]!,
      roomPlacement: {
        face: 'floor',
        u: 0.3,
        v: 0.5,
        scale: 1,
        widthMm: 400,
        heightMm: 700,
        imageAspect: 1,
        contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      },
    }),
    ...over,
  });
  it('잠근 제품만 남고, 그 제품이 기대는 부모도 남는다', () => {
    const parent = standing({ id: uuid(51) });
    const locked = standing({
      id: uuid(52),
      locked: true,
      reconstruction: {
        support: { bathRim: { parentFixtureId: uuid(51) } },
      } as unknown as FixtureInstance['reconstruction'],
    });
    const free = standing({ id: uuid(53) });
    expect(keptByLayout([parent, locked, free]).map((f) => f.id)).toEqual([uuid(51), uuid(52)]);
    expect(keptByLayout([free])).toEqual([]);
  });
  it('잠근 제품을 피해 놓는다. 같은 방이어도 그렇다', () => {
    const m = material(1);
    const kept = standing({ locked: true });
    const { fixtures } = place({
      items: [prepared(item(1, { u: 0.3, v: 0.5 }), m)],
      kept: [kept],
      materials: { [material(5).id]: material(5) },
    });
    expect(placed(fixtures[0]!).u === 0.3 && placed(fixtures[0]!).v === 0.5).toBe(false);
  });
});

describe('사진과 등록', () => {
  it('저장한 방향의 사진을 고르고, 없으면 대신하고 알린다', () => {
    const m = material(1);
    expect(layoutView(m, { direction: '오른쪽', face: 'floor' })).toEqual({ index: 1 });
    // An older spelling reads as the same angle.
    expect(layoutView(m, { direction: 'right', face: 'floor' })).toEqual({ index: 1 });
    expect(layoutView(m, { direction: '왼쪽', face: 'floor' })).toEqual({ index: 0, missing: '왼쪽' });
    const notes = layoutNotes({
      replaced: 2,
      missing: 1,
      otherPhoto: [{ name: '변기', missing: '왼쪽', used: '정면' }],
      tooBig: ['욕조'],
      crowded: ['세면대'],
    });
    expect(notes).toHaveLength(5);
    expect(notes[0]).toContain('2개');
    expect(notes[2]).toContain('‘왼쪽’');
  });
  it('알릴 것이 없으면 조용하다', () => {
    expect(layoutNotes({ replaced: 0, missing: 0, otherPhoto: [], tooBig: [], crowded: [] })).toEqual([]);
  });
  it('등록 묶음에는 다시 만들 값과 그리기 결과가 없고, 공용 자재 id만 담는다', () => {
    const m = material(1);
    const { fixtures } = place({ items: [prepared(item(1, { direction: '오른쪽' }), m, 1)] });
    const scene = {
      fixtures: fixtures.map((f) => ({ ...f, locked: true, projectedQuad: undefined })),
    };
    const { items, refused, asPhoto } = layoutItemsFromScene(scene, { [m.id]: m });
    expect(refused).toEqual([]);
    expect(asPhoto).toEqual([]);
    expect(items).toHaveLength(1);
    expect(layoutItemSchema.safeParse(items[0]).success).toBe(true);
    expect(items[0]!.materialId).toBe(m.materialId);
    expect(items[0]!.direction).toBe('오른쪽');
    for (const key of ['occlusion', 'projectedQuad', 'position', 'id', 'locked', 'reconstruction'])
      expect(items[0]).not.toHaveProperty(key);
    expect(layoutRoomSchema.safeParse({ widthMm: 2400, depthMm: 2400, heightMm: 2400 }).success).toBe(true);
  });
  it('개인 자재·사진 분석 모형은 거절하고, 표준 모형 보기는 사진 제품으로 등록한다', () => {
    const shared = material(1),
      personal = material(2, { scope: 'personal' } as Partial<MaterialVersion>),
      analysed = material(3, { reconstruction: { version: 2, kind: 'toilet' } });
    const { fixtures } = place({
      items: [
        prepared(item(1), shared),
        prepared(item(2, { u: 0.6 }), personal),
        prepared(item(3, { u: 0.8 }), analysed),
      ],
    });
    const asModel = {
      ...fixtures[0]!,
      reconstruction: { version: 2 } as unknown as FixtureInstance['reconstruction'],
    };
    const result = layoutItemsFromScene(
      { fixtures: [asModel, fixtures[1]!, fixtures[2]!] },
      { [shared.id]: shared, [personal.id]: personal, [analysed.id]: analysed },
    );
    expect(result.refused).toEqual([personal.name, analysed.name]);
    expect(result.asPhoto).toEqual([shared.name]);
    expect(result.items).toHaveLength(1);
  });
  it('자재를 읽지 못한 제품은 거절한다', () => {
    const { fixtures } = place({ items: [prepared(item(1), material(1))] });
    expect(layoutItemsFromScene({ fixtures }, {}).refused).toEqual([material(1).name]);
  });
});

describe('끄는 곳', () => {
  it('읽기 전용·Before·방 없음에는 이유가 있고, 그 밖에는 없다', () => {
    const on = { writable: true, before: false, hasRoom: true };
    expect(layoutBlockedReason(on)).toBe('');
    expect(layoutBlockedReason({ ...on, writable: false })).toContain('읽기 전용');
    expect(layoutBlockedReason({ ...on, before: true })).toContain('Before');
    expect(layoutBlockedReason({ ...on, hasRoom: false })).toContain('기본 공간');
  });
});

describe('작은 평면도', () => {
  it('바닥 제품은 사각형, 벽 제품은 그 벽의 막대다', () => {
    const r = { widthMm: 2000, depthMm: 2000, heightMm: 2400 };
    const sizes = new Map([[uuid(1), { widthMm: 400, depthMm: 600 }]]);
    const [floor, back, left, right] = layoutPlanShapes(
      r,
      [
        item(1, { u: 0.5, v: 0.5 }),
        item(1, { face: 'back', u: 0.5 }),
        item(1, { face: 'left', u: 0.75 }),
        item(1, { face: 'right', u: 0.25 }),
      ],
      sizes,
    );
    expect(floor).toEqual({ x: 800, y: 700, width: 400, height: 600, wall: false });
    expect(back).toMatchObject({ x: 800, y: 0, width: 400, wall: true });
    // Both u's stand 500 mm from the back wall (a side wall's u runs opposite ways).
    expect(left).toMatchObject({ x: 0, y: 300, height: 400 });
    expect(right!.y).toBe(300);
    expect(right!.x).toBeGreaterThan(1900);
  });
  it('자재 정보가 없는 항목은 그리지 않는다', () => {
    expect(layoutPlanShapes({ widthMm: 2000, depthMm: 2000, heightMm: 2400 }, [item(9)], new Map())).toEqual(
      [],
    );
  });
});
