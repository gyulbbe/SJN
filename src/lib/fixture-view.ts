import type { AssetRepository } from './repositories/contracts';
import { productContentBounds, projectRoomFixture } from './room-fixtures';
import type { ProductBounds } from './room-types';
import type { MaterialVersion, Point, Scene } from './types';

/** What a product needs to show another of its photos: read once, before the scene is changed. */
export type PreparedFixtureView = {
  index: number;
  anchor: Point;
  assetWidth: number;
  assetHeight: number;
  /** The photo's visible area; only a product placed in a room (with a roomPlacement) needs it. */
  contentBounds?: ProductBounds;
};

/** Reads the photo of view `index` of a material (its size and visible area) for `applyFixtureView`. */
export async function prepareFixtureView(
  view: MaterialVersion['views'][number],
  index: number,
  assets: Pick<AssetRepository, 'get'>,
  inRoom: boolean,
): Promise<PreparedFixtureView> {
  const asset = await assets.get(view.assetId);
  if (asset.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
  if (
    !Number.isFinite(asset.width) ||
    !Number.isFinite(asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0
  )
    throw new Error('선택한 제품 이미지의 가로·세로 크기를 확인할 수 없어요.');
  return {
    index,
    anchor: { ...view.anchor },
    assetWidth: asset.width,
    assetHeight: asset.height,
    contentBounds: inRoom ? { ...(await productContentBounds(asset)) } : undefined,
  };
}

/**
 * Shows another photo of the product: its index, anchor, visible area, aspect and drawn height. A
 * product in a room is projected again, so its place on the picture follows (the editor does the
 * same after every change). Call it inside one scene change so the switch is one undo step.
 */
export function applyFixtureView(scene: Scene, fixtureId: string, prepared: PreparedFixtureView) {
  const product = scene.fixtures.find((item) => item.id === fixtureId);
  if (!product) return undefined;
  product.viewIndex = prepared.index;
  product.anchor = { ...prepared.anchor };
  if (product.roomPlacement && prepared.contentBounds) {
    product.roomPlacement.contentBounds = { ...prepared.contentBounds };
    product.roomPlacement.imageAspect = prepared.assetWidth / prepared.assetHeight;
  }
  product.height =
    (((product.width * scene.imageWidth) / scene.imageHeight) * prepared.assetHeight) / prepared.assetWidth;
  if (scene.room) projectRoomFixture(scene.room, product, scene.imageWidth / scene.imageHeight);
  return product;
}
