import type { PublicPlacement } from './catalog/placement-contract';
import type { LayoutItem } from './fixture-layout-contract';
import { layoutView, type PreparedItem } from './fixture-layouts';
import type { RepositoryOperations } from './repositories/contracts';
import { createRoomPlacement } from './room-fixtures';
import type { MaterialVersion } from './types';

/**
 * Everything a layout's products need read before they are placed: the versions not known yet (one
 * request), then the photos. The project editor's press and the 기본 배치 editor share it.
 */
export async function prepareLayoutItems(
  layout: { items: readonly LayoutItem[]; missing?: number },
  placements: readonly PublicPlacement[],
  known: Record<string, MaterialVersion>,
  repositories: Pick<RepositoryOperations, 'materials' | 'assets'>,
) {
  const byMaterial = new Map(placements.map((placement) => [placement.materialId, placement]));
  const versionIds = [
    ...new Set(layout.items.flatMap((item) => byMaterial.get(item.materialId)?.versionId ?? [])),
  ];
  const unread = versionIds.filter((versionId) => !known[versionId]);
  const batch = unread.length
    ? await repositories.materials.getVersions(unread, { withCurrent: true })
    : { versions: [], current: [] };
  const read = Object.fromEntries(batch.versions.map((version) => [version.id, version]));
  const materials = { ...known, ...read };
  const otherPhoto: { name: string; missing: string; used: string }[] = [];
  let missing = layout.missing ?? 0;
  const chosen = layout.items.flatMap((item) => {
    const placement = byMaterial.get(item.materialId);
    const material: MaterialVersion | undefined = placement && materials[placement.versionId];
    const choice = material && layoutView(material, item);
    const view = choice && material.views[choice.index];
    if (!material || !choice || !view) {
      missing++;
      return [];
    }
    if (choice.missing)
      otherPhoto.push({ name: material.name, missing: choice.missing, used: view.direction });
    return [{ item, material, viewIndex: choice.index, view }];
  });
  const prepared: PreparedItem[] = await Promise.all(
    chosen.map(async ({ item, material, viewIndex, view }) => {
      const asset = await repositories.assets.get(view.assetId);
      const { imageAspect, contentBounds } = await createRoomPlacement(material, asset, item.face);
      return { item, material, viewIndex, imageAspect, contentBounds };
    }),
  );
  return { prepared, read, materials, current: batch.current, otherPhoto, missing };
}
