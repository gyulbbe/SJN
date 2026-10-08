import { viewDirectionAngle } from './product-direction';
import { RECONSTRUCTION_DEFAULTS } from './reconstruction/types';
import type { ProductBounds } from './room-types';
import type { FixtureInstance, MaterialVersion, Scene } from './types';

/**
 * "표준 모형으로 보기": a product placed from a photo can be shown as the standard model of its kind
 * (the generic toilet, basin or bath the 3D room builds in code) instead of a photo plane. Seen from
 * above or the side, a plane is a line and the product disappears from the AI input; the model is a
 * solid from every side (docs/product-representation-results-20261004.md).
 *
 * Nothing new is stored. The switch writes the fixture's existing `reconstruction` field, and takes
 * it away again; the photo (viewIndex, anchor, placement, material) stays, so the photo comes back.
 * The only value that moves is a wall product's `v`, because a standard model on a wall is placed by
 * its lower edge (`v` = 1 − base height / room height, see syncReconstructionHeight) and a photo by
 * its anchor.
 */

/** The kinds that can be switched: the material's category, and the model of that name. */
export const STANDARD_MODEL_KINDS = ['toilet', 'basin', 'bath'] as const;
export type StandardModelKind = (typeof STANDARD_MODEL_KINDS)[number];

/**
 * The kind a photo product can be shown as, or none. A material that carries the reconstruction mark is
 * a standard model already (a photo reconstruction made it): it has no photo to come back to.
 */
export function standardModelKind(
  material: Pick<MaterialVersion, 'category' | 'reconstruction'> | undefined,
): StandardModelKind | undefined {
  if (!material || material.reconstruction) return undefined;
  return (STANDARD_MODEL_KINDS as readonly string[]).includes(material.category)
    ? (material.category as StandardModelKind)
    : undefined;
}

/** A photo product that is shown as its standard model right now (the switch is on). */
export function isStandardModelOfPhoto(
  fixture: Pick<FixtureInstance, 'reconstruction'>,
  material: Pick<MaterialVersion, 'reconstruction'> | undefined,
): boolean {
  return fixture.reconstruction?.version === 2 && !!material && !material.reconstruction;
}

/** Whether the switch can be turned on for this fixture (in a room, from a photo, of a kind that has a model). */
export function canShowAsStandardModel(
  fixture: Pick<FixtureInstance, 'reconstruction' | 'roomPlacement'>,
  material: Pick<MaterialVersion, 'category' | 'reconstruction'> | undefined,
): boolean {
  return !fixture.reconstruction && !!fixture.roomPlacement && !!standardModelKind(material);
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The colour of a product photo: the mean of the brighter half of its opaque pixels. The photo's
 * shadows and dark inner parts would pull a plain mean towards grey (a white toilet photographed
 * reads as #adacad); the brighter half is the glazed surface. Bytes are RGBA, as ImageData has them.
 * Brightness is Rec. 709 luma on 256 levels; the half is exact (the middle level counts in part).
 */
export function brightHalfColor(rgba: ArrayLike<number>): string | undefined {
  const count = new Float64Array(256),
    sum = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let opaque = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const level = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
    count[level]++;
    for (let c = 0; c < 3; c++) sum[c][level] += rgba[i + c];
    opaque++;
  }
  if (!opaque) return undefined;
  let need = Math.ceil(opaque / 2);
  const total = [0, 0, 0];
  let taken = 0;
  for (let level = 255; level >= 0 && need > 0; level--) {
    if (!count[level]) continue;
    const share = Math.min(1, need / count[level]);
    for (let c = 0; c < 3; c++) total[c] += sum[c][level] * share;
    taken += count[level] * share;
    need -= count[level] * share;
  }
  return `#${total
    .map((v) =>
      Math.round(v / taken)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The colour of a photo's file, drawn small (the browser reads it; the pixels go to brightHalfColor). */
export async function readPhotoColor(photo: Blob): Promise<string | undefined> {
  const bitmap = await createImageBitmap(photo);
  try {
    const shrink = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * shrink));
    canvas.height = Math.max(1, Math.round(bitmap.height * shrink));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return brightHalfColor(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } finally {
    bitmap.close();
  }
}

/** Where the anchor sits inside the visible part of the photo, 0 at its top and 1 at its bottom. */
function anchorDown(anchorY: number, bounds: ProductBounds) {
  const height = bounds.bottom - bounds.top;
  return height > 0 ? Math.max(0, Math.min(1, (anchorY - bounds.top) / height)) : 1;
}
/** How far the lowest visible point of the photo hangs below its anchor (mm). */
function belowAnchorMm(fixture: FixtureInstance, heightMm: number) {
  const placement = fixture.roomPlacement!;
  return (1 - anchorDown(fixture.anchor.y, placement.contentBounds)) * heightMm * placement.scale;
}

/**
 * What the model starts with, and why:
 * - toilet: the lid closed, the model's own default; a closed toilet is the commonest look and has no
 *   inner opening that the AI could read as a hole (the seat-only model drew a black hole in the
 *   2026-10-04 top view). The person can open it or leave the seat only.
 * - basin: wall-hung when the material is installed on a wall, else on a pedestal; a round bowl, as
 *   most registered basins are round-fronted, one bowl.
 * - bath: the plain model.
 * The colour is the photo's (brightHalfColor), the size the material's width × height × depth; a
 * material with no depth takes the kind's usual depth, since a model needs one.
 */
function startOptions(kind: StandardModelKind, material: MaterialVersion) {
  if (kind === 'toilet') return { toiletLidState: 'closed' as const };
  if (kind === 'basin')
    return {
      basinVariant: material.installation === 'wall' ? ('wall' as const) : ('pedestal' as const),
      basinShape: 'round' as const,
      bowlCount: 1 as const,
    };
  return {};
}

export type StandardModelColor = string | undefined;
/** The model's colour: the photo's, else the material's own colour, else the kind's usual one. */
function modelColor(kind: StandardModelKind, material: MaterialVersion, photo: StandardModelColor) {
  if (photo && HEX.test(photo)) return photo.toLowerCase();
  if (HEX.test(material.color)) return material.color.toLowerCase();
  return RECONSTRUCTION_DEFAULTS[kind].color;
}

/**
 * Shows the fixture as its standard model: sets `reconstruction` from the material and the photo
 * product's place. Returns whether it did (a room, a placement, a kind with a model, not already on).
 * Floor: the model stands on the floor at the same place, facing where the photo's angle name says
 * (정면 front, 오른쪽 right …; 위 and 아래 name none, so front). Wall: it faces into the room (the face
 * decides) and hangs where the photo's lowest point hung, so its `v` follows its lower edge.
 */
export function showAsStandardModel(
  scene: Scene,
  fixtureId: string,
  material: MaterialVersion,
  photoColor?: StandardModelColor,
): boolean {
  const fixture = scene.fixtures.find((item) => item.id === fixtureId);
  const placement = fixture?.roomPlacement;
  const kind = standardModelKind(material);
  if (!scene.room || !fixture || !placement || !kind || fixture.reconstruction) return false;
  const floor = placement.face === 'floor';
  const widthMm = material.widthMm,
    heightMm = material.heightMm;
  const depthMm = material.depthMm > 0 ? material.depthMm : RECONSTRUCTION_DEFAULTS[kind].depthMm;
  let baseHeightMm = 0;
  if (!floor) {
    const room = scene.room.heightMm;
    baseHeightMm = Math.max(
      0,
      Math.min(
        Math.max(0, room - heightMm * placement.scale),
        (1 - placement.v) * room - belowAnchorMm(fixture, heightMm),
      ),
    );
    placement.v = 1 - baseHeightMm / room;
  }
  const facing = viewDirectionAngle(material.views[fixture.viewIndex]?.direction);
  fixture.reconstruction = {
    version: 2,
    kind,
    color: modelColor(kind, material, photoColor),
    widthMm,
    heightMm,
    depthMm,
    baseHeightMm,
    yawDegrees: floor ? (facing ?? 0) : 0,
    ...startOptions(kind, material),
  };
  return true;
}

/**
 * Shows the photo again: takes `reconstruction` away and puts back what the model's projection
 * overwrote (the photo's anchor, from the material's photo) and a wall product's `v` (the anchor's
 * place, from the model's lower edge). Returns whether it did. Only a switch-made model is touched.
 */
export function showAsPhoto(scene: Scene, fixtureId: string, material: MaterialVersion | undefined): boolean {
  const fixture = scene.fixtures.find((item) => item.id === fixtureId);
  const placement = fixture?.roomPlacement;
  if (!scene.room || !fixture || !placement || !isStandardModelOfPhoto(fixture, material)) return false;
  const model = fixture.reconstruction!;
  const view = material!.views[fixture.viewIndex];
  if (view) fixture.anchor = { ...view.anchor };
  if (placement.face !== 'floor') {
    const room = scene.room.heightMm;
    const base = model.baseHeightMm ?? (1 - placement.v) * room;
    const anchorY = base + belowAnchorMm(fixture, material!.heightMm);
    placement.v = Math.max(0, Math.min(1, 1 - anchorY / room));
  }
  delete fixture.reconstruction;
  return true;
}
