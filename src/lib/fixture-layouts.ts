import type { LayoutItem, LayoutRoom } from './fixture-layout-contract';
import { getPlacementViewIndex } from './material-images';
import { readProductDirection, viewDirection } from './product-direction';
import { createPlacedFixture, projectRoomFixture } from './room-fixtures';
import {
  boxesClose,
  faceLengths,
  findFreeSlot,
  slotBox,
  slotObstacles,
  type FreeSlot,
  type PlacedBox,
} from './room-slot';
import type { ProductBounds, RoomDefinition, RoomFace } from './room-types';
import { behindWall, freeWallSlot, wallContactPlace } from './room-wall-contact';
import type { FixtureInstance, MaterialVersion, Scene } from './types';

/**
 * 기본 배치 (docs/fixture-layouts-results-20261101.md): what is registered from a scene, and where its
 * products stand in another room. No screen code: a room, the items, the materials and their photos go
 * in; the products and what to tell the person come out.
 */

/** Why a press places nothing here, or nothing when it can. */
export function layoutBlockedReason(state: { writable: boolean; before: boolean; hasRoom: boolean }): string {
  if (!state.writable) return '읽기 전용이라 기본 배치를 놓을 수 없어요.';
  if (state.before) return 'Before 편집에서는 기본 배치를 놓을 수 없어요. After 시안에서 눌러 주세요.';
  if (!state.hasRoom) return '기본 공간으로 만든 프로젝트에서만 기본 배치를 놓을 수 있어요.';
  return '';
}

/** What a press leaves in place: the locked products, and the parent a locked one is supported by. */
export function keptByLayout(fixtures: readonly FixtureInstance[]): FixtureInstance[] {
  const parents = new Set(
    fixtures.flatMap((fixture) => {
      const support = fixture.locked ? fixture.reconstruction?.support : undefined;
      return [support?.bathRim?.parentFixtureId, support?.partitionTop?.parentFixtureId].flatMap(
        (id) => id ?? [],
      );
    }),
  );
  return fixtures.filter((fixture) => fixture.locked || parents.has(fixture.id));
}

export type RegisteredLayout = {
  items: LayoutItem[];
  /** Products that cannot go in, by name: not shared, a photo analysis's model, or not read. */
  refused: string[];
  /** Products shown as a standard model now: they go in as their photo. */
  asPhoto: string[];
};
/** What a scene's products register as. Only what is decided here is kept, never what drawing makes. */
export function layoutItemsFromScene(
  scene: Pick<Scene, 'fixtures'>,
  materials: Record<string, MaterialVersion | undefined>,
): RegisteredLayout {
  const items: LayoutItem[] = [],
    refused: string[] = [],
    asPhoto: string[] = [];
  for (const fixture of scene.fixtures) {
    const material = materials[fixture.materialVersionId];
    const placement = fixture.roomPlacement;
    const view = material?.views[fixture.viewIndex];
    if (!material || !placement || !view || material.scope !== 'shared' || material.reconstruction) {
      refused.push(fixture.name);
      continue;
    }
    if (fixture.reconstruction) asPhoto.push(fixture.name);
    items.push({
      materialId: material.materialId,
      face: placement.face,
      u: placement.u,
      v: placement.v,
      scale: placement.scale,
      ...(placement.againstWall ? { againstWall: true as const } : {}),
      rotation: fixture.rotation,
      direction: view.direction,
      color: { ...fixture.color },
      shadow: { ...fixture.shadow },
    });
  }
  return { items, refused, asPhoto };
}

/**
 * The photo an item is placed with: the current version's photo of the registered angle, else the one
 * that suits the face, and the angle that was missing.
 */
export function layoutView(
  material: Pick<MaterialVersion, 'views'>,
  item: Pick<LayoutItem, 'direction' | 'face'>,
): { index: number; missing?: string } {
  const exact = material.views.findIndex((view) => view.direction === item.direction);
  if (exact >= 0) return { index: exact };
  const wanted = viewDirection(item.direction);
  const same = wanted ? material.views.findIndex((view) => viewDirection(view.direction) === wanted) : -1;
  if (same >= 0) return { index: same };
  return { index: getPlacementViewIndex(material, item.face).index, missing: item.direction };
}

/** The place in a room of another size: the same share of each wall, a wall product at the same height. */
export function layoutPlaceInRoom(
  item: Pick<LayoutItem, 'face' | 'u' | 'v'>,
  from: LayoutRoom,
  to: LayoutRoom,
): { u: number; v: number } {
  if (item.face === 'floor' || from.heightMm === to.heightMm) return { u: item.u, v: item.v };
  return { u: item.u, v: Math.max(0, Math.min(1, 1 - ((1 - item.v) * from.heightMm) / to.heightMm)) };
}

const sameRoom = (a: LayoutRoom, b: LayoutRoom) =>
  a.widthMm === b.widthMm && a.depthMm === b.depthMm && a.heightMm === b.heightMm;

/** An item with its current material and the photo read for it. */
export type PreparedItem = {
  item: LayoutItem;
  material: MaterialVersion;
  viewIndex: number;
  /** The photo's size and visible area (createRoomPlacement). */
  imageAspect: number;
  contentBounds: ProductBounds;
};
export type PlacedLayout = {
  /** In the registered order. */
  fixtures: FixtureInstance[];
  /** Products left out because they do not fit this room, by name. */
  tooBig: string[];
  /** Products that overlap another because no free place was left, by name. */
  crowded: string[];
};
/**
 * The products of a layout in `room`, around the products that stay (`kept`).
 *
 * In the room it was registered in, with nothing kept, every product stands exactly where it was
 * registered. Otherwise a product past a wall or on another product goes to the nearest free place (a
 * wall product along the wall, at its height; one against a wall along that wall), and with none it
 * overlaps and is reported. Products registered touching (a faucet on a basin) are not moved apart.
 * The biggest go first, so the result depends only on what goes in.
 */
export function placeLayout(input: {
  room: RoomDefinition;
  aspect: number;
  registeredRoom: LayoutRoom;
  items: PreparedItem[];
  kept: readonly FixtureInstance[];
  /** The materials of the kept products, for their depth. */
  materials: Record<string, MaterialVersion | undefined>;
  newId: () => string;
}): PlacedLayout {
  const { room, aspect, registeredRoom, kept, newId } = input;
  const unchanged = sameRoom(room, registeredRoom);
  const versions = { ...input.materials };
  for (const { material } of input.items) versions[material.id] = material;
  const prepared = input.items.map((entry, order) => {
    const { item, material } = entry;
    const view = material.views[entry.viewIndex]!;
    const place = layoutPlaceInRoom(item, registeredRoom, room);
    const fixture = createPlacedFixture({
      id: newId(),
      material,
      viewIndex: entry.viewIndex,
      view,
      roomPlacement: {
        face: item.face,
        ...place,
        scale: item.scale,
        widthMm: material.widthMm,
        heightMm: material.heightMm,
        imageAspect: entry.imageAspect,
        contentBounds: { ...entry.contentBounds },
      },
    });
    fixture.rotation = item.rotation;
    fixture.color = { ...item.color };
    fixture.shadow = { ...item.shadow };
    const box = slotBox(fixture.roomPlacement!, fixture.anchor, material.depthMm);
    return { entry, order, fixture, box };
  });
  // Biggest first; the registered order settles a tie.
  const area = ({ box, fixture }: (typeof prepared)[number]) =>
    box.widthMm * (fixture.roomPlacement!.face === 'floor' ? box.depthMm : box.heightMm);
  const queue = [...prepared].sort((a, b) => area(b) - area(a) || a.order - b.order);
  const placed: (typeof prepared)[number][] = [];
  const tooBig: string[] = [],
    crowded: string[] = [];
  for (const product of queue) {
    const { fixture, box, entry } = product;
    const placement = fixture.roomPlacement!;
    const face = placement.face;
    if (!unchanged && tooBigFor(room, face, box)) {
      tooBig.push(fixture.name);
      continue;
    }
    const wall = entry.item.againstWall ? behindWall(fixture, versions) : undefined;
    const contact = wall && wallContactPlace(room, fixture, versions, wall);
    if (contact) Object.assign(placement, contact, { againstWall: true as const });
    // Products registered touching stay touching.
    const others = placed.filter(
      (other) =>
        other.fixture.roomPlacement!.face === face &&
        !boxesClose(registeredRoom, face, registeredBox(product), registeredBox(other)),
    );
    const obstacles: PlacedBox[] = [
      ...slotObstacles({ fixtures: [...kept] }, face, versions),
      ...others.map((other) => ({
        ...other.box,
        u: other.fixture.roomPlacement!.u,
        v: other.fixture.roomPlacement!.v,
      })),
    ];
    if (!(unchanged && !obstacles.length)) {
      let slot: FreeSlot | undefined = contact
        ? freeWallSlot(room, fixture, versions, box, obstacles)
        : undefined;
      if (contact && !slot) delete placement.againstWall;
      slot ??= findFreeSlot(room, face, box, obstacles, {
        defaultSlot: { u: placement.u, v: placement.v },
        ...(face === 'floor' ? {} : { along: 'u' as const }),
      });
      placement.u = slot.u;
      placement.v = slot.v;
      if (slot.status === 'crowded') crowded.push(fixture.name);
    }
    try {
      projectRoomFixture(
        room,
        fixture,
        aspect,
        placement.againstWall ? behindWall(fixture, versions) : undefined,
        viewDirection(entry.material.views[entry.viewIndex]?.direction) ?? '정면',
      );
    } catch {
      tooBig.push(fixture.name);
      continue;
    }
    placed.push(product);
  }
  return {
    fixtures: placed.sort((a, b) => a.order - b.order).map((product) => product.fixture),
    tooBig,
    crowded,
  };
  function registeredBox(product: (typeof prepared)[number]): PlacedBox {
    return { ...product.box, u: product.entry.item.u, v: product.entry.item.v };
  }
}
function tooBigFor(
  room: RoomDefinition,
  face: RoomFace,
  box: { widthMm: number; heightMm: number; depthMm: number },
) {
  const length = faceLengths(room, face);
  return box.widthMm > length.u || (face === 'floor' ? box.depthMm : box.heightMm) > length.v;
}

/** What to tell the person after a press. */
export function layoutNotes(result: {
  replaced: number;
  missing: number;
  /** Each product placed with another photo than the registered angle's: its stand-in's name. */
  otherPhoto: { name: string; missing: string; used: string }[];
  tooBig: string[];
  crowded: string[];
}): string[] {
  return [
    result.replaced ? `제품 ${result.replaced}개를 이 배치로 바꿨어요. Ctrl+Z로 되돌릴 수 있어요.` : '',
    result.missing ? `지금은 쓸 수 없는 제품 ${result.missing}개를 빼고 놓았어요.` : '',
    ...result.otherPhoto.map(
      (photo) =>
        `${photo.name}: ‘${readProductDirection(photo.missing).name}’ 각도 사진이 없어 ‘${readProductDirection(photo.used).name}’ 사진으로 놓았어요.`,
    ),
    result.tooBig.length ? `공간보다 커서 뺀 제품: ${result.tooBig.join(', ')}` : '',
    result.crowded.length
      ? `놓을 자리가 없어 겹쳐 놓았어요: ${result.crowded.join(', ')}. 위치를 옮겨 주세요.`
      : '',
  ].filter(Boolean);
}

/**
 * A card's small floor plan, in millimetres of the registered room (x across, y from the back wall):
 * a rectangle for a floor product, a thin bar along its wall for a wall product.
 */
export type PlanShape = { x: number; y: number; width: number; height: number; wall: boolean };
export function layoutPlanShapes(
  room: LayoutRoom,
  items: readonly LayoutItem[],
  sizes: ReadonlyMap<string, { widthMm: number; depthMm: number }>,
): PlanShape[] {
  const bar = Math.max(room.widthMm, room.depthMm) * 0.035;
  return items.flatMap((item) => {
    const size = sizes.get(item.materialId);
    if (!size) return [];
    const width = size.widthMm * item.scale;
    const depth = (size.depthMm > 0 ? size.depthMm : size.widthMm / 2) * item.scale;
    const wall = item.face !== 'floor';
    if (item.face === 'floor')
      return [
        {
          x: item.u * room.widthMm - width / 2,
          y: item.v * room.depthMm - depth / 2,
          width,
          height: depth,
          wall,
        },
      ];
    if (item.face === 'back')
      return [{ x: item.u * room.widthMm - width / 2, y: 0, width, height: bar, wall }];
    // A side wall's u runs from the front on the left wall and from the back on the right wall.
    const along = (item.face === 'left' ? 1 - item.u : item.u) * room.depthMm;
    return [
      {
        x: item.face === 'left' ? 0 : room.widthMm - bar,
        y: along - width / 2,
        width: bar,
        height: width,
        wall,
      },
    ];
  });
}
