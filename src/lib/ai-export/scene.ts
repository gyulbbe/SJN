import {
  categoryLabels,
  isImageAsset,
  type AssetRecord,
  type FixtureInstance,
  type MaterialCategory,
  type MaterialVersion,
  type RenderSnapshot,
} from '../types';
import { finishAppearance } from '../render/finish';
import { resolveBathRimFixture } from '../reconstruction/bath-rim';
import type { FluxInputLayout } from './contract';
import { FLUX_KIND_PRIORITY } from './prompt';
import {
  FLUX_FIXTURE_KINDS,
  FLUX_MAX_FIXTURES,
  FLUX_MAX_SURFACES,
  type FluxFace,
  type FluxFinish,
  type FluxFixture,
  type FluxFixtureForm,
  type FluxFixtureKind,
  type FluxScene,
  type FluxSurface,
} from './scene-contract';

/** [left, top, right, bottom], normalised to an image. */
export type Box = [number, number, number, number];
type Point = { x: number; y: number };

const KINDS = new Set<string>(FLUX_FIXTURE_KINDS);
const HEX = /^#[0-9a-f]{6}$/i;
/** Below this share of the image the object is too small to describe usefully. */
const MIN_AREA = 0.0002;

function clampBox(points: Point[]): Box | undefined {
  if (!points.length || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const box: Box = [
    clamp(Math.min(...points.map((p) => p.x))),
    clamp(Math.min(...points.map((p) => p.y))),
    clamp(Math.max(...points.map((p) => p.x))),
    clamp(Math.max(...points.map((p) => p.y))),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : undefined;
}

/**
 * The fixture's box in the front (2D compositor) image, with the same maths as its fixture shader:
 * a perspective quad when present, otherwise the anchored rectangle rotated in pixel space.
 */
export function fixtureImageBox(fixture: FixtureInstance, aspect: number): Box | undefined {
  if (fixture.projectedQuad?.length === 4) return clampBox(fixture.projectedQuad);
  const { position: p, width: w, height: h, anchor: a } = fixture;
  if (![p.x, p.y, w, h, a.x, a.y, aspect].every(Number.isFinite) || w <= 0 || h <= 0 || aspect <= 0) return;
  const angle = ((fixture.rotation || 0) * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return clampBox(
    [
      [-a.x, -a.y],
      [1 - a.x, -a.y],
      [1 - a.x, 1 - a.y],
      [-a.x, 1 - a.y],
    ].map(([u, v]) => {
      const dx = u * w * aspect,
        dy = v * h;
      return { x: p.x + (c * dx - s * dy) / aspect, y: p.y + (s * dx + c * dy) };
    }),
  );
}

/** Moves a box from the captured After image into the padded FLUX input image. */
export function toInputBox(box: Box, layout: FluxInputLayout): Box {
  const x = (value: number) => (layout.x + value * layout.contentWidth) / layout.width;
  const y = (value: number) => (layout.y + value * layout.contentHeight) / layout.height;
  return [x(box[0]), y(box[1]), x(box[2]), y(box[3])];
}

export function finishCategory(finish: string | undefined, kind?: FluxFixtureKind): FluxFinish {
  const text = finish?.trim() ?? '';
  const appearance = finishAppearance(text);
  const explicitMatte = /무광|매트|matt|엠보|emboss|논슬립|non-?slip/i.test(text);
  if (appearance.metalness > 0.5) return 'metal';
  if (appearance.gloss >= 0.95) return 'polished';
  if (appearance.gloss >= 0.6) return 'glossy';
  if (appearance.gloss >= 0.3) return 'semi-gloss';
  if (explicitMatte || !kind) return 'matte';
  // No usable finish text: ceramic sanitaryware is glazed, shower hardware is metal.
  return kind === 'toilet' || kind === 'basin' || kind === 'bath'
    ? 'glossy'
    : kind === 'faucet' || kind === 'shower'
      ? 'metal'
      : 'matte';
}

export type FixtureDraft = Omit<FluxFixture, 'color'> & {
  id: string;
  color?: string;
  captureBox: Box;
  area: number;
  /** Selected-direction product photo, read locally for its colour only; never sent. */
  photoAssetId?: string;
};

/** Enum-only description of one placed fixture; undefined when it is not a known fixture kind. */
export function describeFixture(
  fixture: FixtureInstance,
  material: MaterialVersion | undefined,
  captureBox: Box,
): FixtureDraft | undefined {
  const r = fixture.reconstruction;
  const kind = (
    r && KINDS.has(r.kind) ? r.kind : material && KINDS.has(material.category) ? material.category : undefined
  ) as FluxFixtureKind | undefined;
  if (!kind) return;
  const face: FluxFace =
    fixture.roomPlacement?.face ?? (material?.installation === 'floor' ? 'floor' : 'back');
  const forms: FluxFixtureForm[] = [];
  if (kind === 'toilet') {
    forms.push(face === 'floor' ? 'floor-standing' : 'wall-hung');
    if (r?.toiletLidState) forms.push(r.toiletLidState === 'open' ? 'lid-open' : 'lid-closed');
  } else if (kind === 'basin') {
    forms.push(
      r?.basinVariant === 'pedestal'
        ? 'pedestal'
        : r?.basinVariant === 'vanity'
          ? 'countertop'
          : face === 'floor'
            ? 'pedestal'
            : 'wall-hung',
    );
    if (r?.basinShape) forms.push(r.basinShape);
  } else if (kind === 'shower' && r?.showerVariant)
    forms.push(
      r.showerVariant === 'handheld-rail'
        ? 'handheld-rail'
        : r.showerVariant.startsWith('overhead')
          ? 'overhead'
          : 'handheld',
    );
  else if ((kind === 'mirror' || kind === 'mirrorCabinet') && r?.mirrorShape) forms.push(r.mirrorShape);
  else if (kind === 'vanity' || kind === 'wallCabinet' || kind === 'wallShelf' || kind === 'faucet')
    forms.push(face === 'floor' ? 'floor-standing' : 'wall-hung');
  if (material?.installation === 'suspended') forms.push('suspended');
  else if (material?.installation === 'embedded' && !forms.includes('built-in')) forms.push('built-in');

  const scale = fixture.roomPlacement?.scale ?? 1;
  const size = (value: number | undefined) =>
    Math.max(1, Math.min(20000, Number.isFinite(value) ? (value as number) * scale : 1));
  const photo = r
    ? undefined
    : material?.views?.[fixture.viewIndex]?.assetId ||
      material?.coverAssetId ||
      material?.imageAssetIds?.[0] ||
      undefined;
  const color =
    r && HEX.test(r.color) ? r.color : material && HEX.test(material.color) ? material.color : undefined;
  return {
    id: fixture.id,
    kind,
    forms: forms.slice(0, 4),
    face,
    ...(color ? { color: color.toLowerCase() } : {}),
    finish: finishCategory(material?.finish, kind),
    sizeMm: [
      size(r?.widthMm ?? fixture.roomPlacement?.widthMm ?? material?.widthMm),
      size(r?.heightMm ?? fixture.roomPlacement?.heightMm ?? material?.heightMm),
      size(r?.depthMm ?? material?.depthMm),
    ],
    box: captureBox,
    captureBox,
    area: (captureBox[2] - captureBox[0]) * (captureBox[3] - captureBox[1]),
    ...(photo ? { photoAssetId: photo } : {}),
  };
}

/** Easily replaced kinds first, larger first within a kind; ties keep scene order. */
export function orderFixtures<T extends { kind: FluxFixtureKind; area: number }>(drafts: T[]): T[] {
  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort(
      (a, b) =>
        FLUX_KIND_PRIORITY[a.draft.kind] - FLUX_KIND_PRIORITY[b.draft.kind] ||
        b.draft.area - a.draft.area ||
        a.index - b.index,
    )
    .map(({ draft }) => draft);
}

const KOREAN_WHERE = (box: Box) => {
  const x = (box[0] + box[2]) / 2,
    y = (box[1] + box[3]) / 2;
  const h = x < 0.36 ? '왼쪽' : x > 0.64 ? '오른쪽' : '가운데';
  const v = y < 0.36 ? '위' : y > 0.64 ? '아래' : '';
  return v ? `${h} ${v}` : h;
};

const whole = (image: { width: number; height: number }) => ({
  x: 0,
  y: 0,
  width: image.width,
  height: image.height,
});
function toHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}
/** Alpha-weighted mean colour of a region, read from a small resample. */
function averageColor(
  source: CanvasImageSource,
  region: { x: number; y: number; width: number; height: number },
): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || region.width < 1 || region.height < 1) return;
  context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, 48, 48);
  const data = context.getImageData(0, 0, 48, 48).data;
  let r = 0,
    g = 0,
    b = 0,
    weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    r += data[i] * a;
    g += data[i + 1] * a;
    b += data[i + 2] * a;
    weight += a;
  }
  return weight > 1 ? toHex(r / weight, g / weight, b / weight) : undefined;
}

async function assetBitmap(reader: FluxAssetReader, id: string | undefined) {
  if (!id) return;
  try {
    const asset = await reader(id);
    return asset && isImageAsset(asset) ? await createImageBitmap(asset.blob) : undefined;
  } catch {
    return;
  }
}

export type FluxAssetReader = (id: string) => Promise<AssetRecord | undefined>;
/** One After capture plus the snapshot it was rendered from (and 3D boxes when the viewer drew it). */
export type FluxCaptureSource = {
  blob: Blob;
  snapshot: RenderSnapshot;
  reader: FluxAssetReader;
  boxes?: Record<string, Box>;
};
export type FluxPlacedProduct = { id: string; label: string; where: string };
export type FluxGrounding = { scene: FluxScene; placed: FluxPlacedProduct[] };

/**
 * Builds the structured scene for one FLUX request: what each placed fixture is, where it sits in
 * the model input and its colour, plus the tile surfaces. Only this text-able data is sent.
 */
export async function buildFluxGrounding(input: {
  snapshot: RenderSnapshot;
  reader: FluxAssetReader;
  capture: ImageBitmap;
  layout: FluxInputLayout;
  /** Boxes from the 3D viewer, keyed by fixture id; the 2D path derives them from the scene. */
  boxes?: Record<string, Box>;
}): Promise<FluxGrounding> {
  const { snapshot, reader, capture, layout, boxes } = input;
  const scene = snapshot.scene;
  const aspect = capture.width / capture.height;
  const drafts: FixtureDraft[] = [];
  for (const fixture of scene.fixtures) {
    if (resolveBathRimFixture(scene, fixture).status === 'held') continue;
    const box = boxes ? boxes[fixture.id] : fixtureImageBox(fixture, aspect);
    if (!box) continue;
    const draft = describeFixture(fixture, snapshot.materials[fixture.materialVersionId], box);
    if (draft && draft.area >= MIN_AREA) drafts.push(draft);
  }
  const ordered = orderFixtures(drafts).slice(0, FLUX_MAX_FIXTURES);
  const pixels = (box: Box) => ({
    x: box[0] * capture.width,
    y: box[1] * capture.height,
    width: (box[2] - box[0]) * capture.width,
    height: (box[3] - box[1]) * capture.height,
  });
  const fixtures: FluxFixture[] = [];
  const placed: FluxPlacedProduct[] = [];
  for (const draft of ordered) {
    let color = draft.color;
    if (!color) {
      const photo = await assetBitmap(reader, draft.photoAssetId);
      color = photo ? averageColor(photo, whole(photo)) : undefined;
      photo?.close();
    }
    color ??= averageColor(capture, pixels(draft.captureBox));
    fixtures.push({
      kind: draft.kind,
      forms: draft.forms,
      face: draft.face,
      color: (color ?? '#ffffff').toLowerCase(),
      finish: draft.finish,
      sizeMm: draft.sizeMm,
      box: toInputBox(draft.captureBox, layout),
    });
    placed.push({
      id: draft.id,
      label: categoryLabels[draft.kind as MaterialCategory] ?? draft.kind,
      where: KOREAN_WHERE(draft.captureBox),
    });
  }

  const surfaces: FluxSurface[] = [];
  const textureColors = new Map<string, string | undefined>();
  for (const surface of scene.surfaces) {
    const material = surface.materialVersionId ? snapshot.materials[surface.materialVersionId] : undefined;
    if (!material || material.category !== 'tile') continue;
    const textureId = material.textureAssetIds[0] ?? material.coverAssetId;
    if (textureId && !textureColors.has(textureId)) {
      const bitmap = await assetBitmap(reader, textureId);
      textureColors.set(textureId, bitmap ? averageColor(bitmap, whole(bitmap)) : undefined);
      bitmap?.close();
    }
    const color =
      (textureId && textureColors.get(textureId)) || (HEX.test(material.color) ? material.color : undefined);
    if (!color || !HEX.test(surface.tile.groutColor)) continue;
    const face: FluxFace = surface.roomFace ?? (surface.kind === 'floor' ? 'floor' : 'back');
    const entry: Omit<FluxSurface, 'faces'> = {
      color: color.toLowerCase(),
      tileMm: [
        Math.max(1, Math.min(20000, material.widthMm)),
        Math.max(1, Math.min(20000, material.heightMm)),
      ],
      pattern: surface.tile.pattern === 'brick' ? 'brick' : 'grid',
      groutColor: surface.tile.groutColor.toLowerCase(),
      groutMm: Math.max(0, Math.min(50, surface.tile.groutWidth)),
      finish: finishCategory(material.finish),
    };
    // Faces with the same tile, layout and grout are described once ("Back wall and left wall: …").
    const key = (s: Omit<FluxSurface, 'faces'>) =>
      JSON.stringify([s.color, s.tileMm, s.pattern, s.groutColor, s.groutMm, s.finish]);
    const same = surfaces.find((s) => key(s) === key(entry));
    if (same) {
      if (!same.faces.includes(face)) same.faces.push(face);
    } else if (surfaces.length < FLUX_MAX_SURFACES) surfaces.push({ faces: [face], ...entry });
  }
  return { scene: { version: 1, fixtures, surfaces }, placed };
}
