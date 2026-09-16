import {
  Box3,
  Color,
  Vector3,
  type Group,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
} from 'three';
import type { ReconstructionStandardOptions, ShowerVariant } from './types';

export const SHOWER_VARIANTS = ['hand-spray', 'handheld-rail', 'overhead-set', 'handheld-wall', 'overhead-head'] as const;
export const SHOWER_VARIANT_LABELS: Record<ShowerVariant, string> = {
  'hand-spray': '소형 위생 스프레이',
  'handheld-rail': '슬라이드바 핸드샤워',
  'overhead-set': '상부 헤드 샤워 세트',
  'handheld-wall': '벽걸이 핸드샤워·호스·조작부',
  'overhead-head': '고정 샤워 헤드·연결관',
};
/** Editable app defaults for the whole visible kit, not measured dimensions or a head-only box. */
export function showerVariantDefaults(showerVariant: ShowerVariant) {
  if (!SHOWER_VARIANTS.includes(showerVariant)) throw new Error('지원하는 샤워 형태를 선택해 주세요.');
  const dimensions = {
    'hand-spray': { widthMm: 180, heightMm: 450, depthMm: 120, baseHeightMm: 450 },
    'handheld-rail': { widthMm: 250, heightMm: 1000, depthMm: 250, baseHeightMm: 850 },
    'overhead-set': { widthMm: 350, heightMm: 1300, depthMm: 500, baseHeightMm: 750 },
    'handheld-wall': { widthMm: 350, heightMm: 1100, depthMm: 150, baseHeightMm: 800 },
    'overhead-head': { widthMm: 220, heightMm: 180, depthMm: 320, baseHeightMm: 1950 },
  }[showerVariant];
  return { ...dimensions, face: 'back' as const, showerVariant };
}
export const SHOWER_MODEL_PARTS = ['handset', 'rail', 'hose', 'overhead-head'] as const;
export type ShowerModelPart = (typeof SHOWER_MODEL_PARTS)[number];
/** Bounds of explicitly tagged rendered parts. A head-only observation must not become a whole-kit extent. */
export function showerModelPartBounds(model: Group) {
  const result: Partial<
    Record<
      ShowerModelPart,
      {
        min: [number, number, number];
        max: [number, number, number];
        size: [number, number, number];
        meshNames: string[];
      }
    >
  > = {};
  model.updateMatrixWorld(true);
  for (const part of SHOWER_MODEL_PARTS) {
    const box = new Box3(),
      meshNames: string[] = [];
    model.traverse((node) => {
      if (node instanceof Mesh && node.userData.showerPart === part) {
        box.union(new Box3().setFromObject(node, true));
        meshNames.push(node.name);
      }
    });
    if (!box.isEmpty())
      result[part] = {
        min: box.min.toArray(),
        max: box.max.toArray(),
        size: box.getSize(new Vector3()).toArray(),
        meshNames,
      };
  }
  return result;
}

export const OPEN_COUNTER_SUPPORTS = ['wall', 'left-panel', 'right-panel', 'both-panels'] as const;
/** Whole rendered envelope, never the empty space below a floating counter. Defaults are not measurements. */
export function openCounterDefaults(
  support: NonNullable<ReconstructionStandardOptions['counterSupport']> = 'wall',
) {
  return {
    widthMm: 1000,
    heightMm: support === 'wall' ? 330 : 950,
    depthMm: 550,
    baseHeightMm: support === 'wall' ? 650 : 0,
    face: support === 'wall' ? ('back' as const) : ('floor' as const),
    vanityStyle: 'open-counter' as const,
    counterSupport: support,
    basinShape: 'round' as const,
    bowlCount: 1 as const,
  };
}
export function fixtureVariantErrors(
  p: ReconstructionStandardOptions & { kind?: string; face?: string },
): string[] {
  const errors: string[] = [];
  if (
    p.showerVariant !== undefined &&
    (!SHOWER_VARIANTS.includes(p.showerVariant) || p.kind !== 'shower' || p.version !== 2)
  )
    errors.push('샤워 형태는 표준 샤워 모형에서만 선택할 수 있어요.');
  if (p.showerVariant !== undefined && p.face === 'floor')
    errors.push('샤워 설비는 설치 벽과 모형 하단 높이를 선택해 주세요.');
  if (
    p.mirrorShape !== undefined &&
    (!['rectangular', 'oval', 'arched'].includes(p.mirrorShape) || p.kind !== 'mirror' || p.version !== 2)
  )
    errors.push('거울 외곽 형태는 표준 일반 거울에서만 선택할 수 있어요.');
  const assembly = p.kind === 'vanity' || (p.kind === 'basin' && p.basinVariant === 'vanity');
  if (
    p.vanityStyle !== undefined &&
    (!['enclosed', 'open-counter'].includes(p.vanityStyle) || !assembly || p.version !== 2)
  )
    errors.push('상판 형태는 표준 세면대 상판·하부장 모형에서만 선택할 수 있어요.');
  if (
    p.counterSupport !== undefined &&
    (p.vanityStyle !== 'open-counter' || !OPEN_COUNTER_SUPPORTS.includes(p.counterSupport))
  )
    errors.push('상판 지지는 개방형 상판에서 선택해 주세요.');
  if (p.vanityStyle === 'open-counter') {
    if (p.counterSupport === undefined) errors.push('개방형 상판의 벽 지지 또는 패널을 선택해 주세요.');
    if (p.counterSupport === 'wall' && p.face === 'floor')
      errors.push('벽 지지 상판은 설치 벽과 하단 높이를 선택해 주세요.');
    if (p.counterSupport && p.counterSupport !== 'wall' && Math.abs(p.baseHeightMm ?? 0) > 1)
      errors.push('상판 지지 패널 하단은 바닥에 닿아야 해요.');
  }
  return errors;
}
function outline(w: number, h: number, shape: 'oval' | 'arched') {
  const path = new Shape();
  if (shape === 'oval') {
    path.absellipse(0, h / 2, w / 2, h / 2, 0, Math.PI * 2, false, 0);
  } else {
    const radiusY = Math.min(w / 2, h * 0.5);
    path.moveTo(-w / 2, 0);
    path.lineTo(w / 2, 0);
    path.lineTo(w / 2, h - radiusY);
    path.absellipse(0, h - radiusY, w / 2, radiusY, 0, Math.PI, false, 0);
    path.lineTo(-w / 2, 0);
  }
  path.closePath();
  return path;
}
/** Plain manufactured mirror silhouette; no sampled reflection or source image. */
export function shapedMirrorMeshes(
  w: number,
  h: number,
  d: number,
  shape: 'oval' | 'arched',
  hasFrame: boolean,
  color: string,
) {
  const edge = Math.min(w, h) * (hasFrame ? 0.035 : 0.008),
    bodyShape = outline(w, h, shape);
  const body = new Mesh(
    new ExtrudeGeometry(bodyShape, { depth: d, bevelEnabled: false, curveSegments: 64 }),
    new MeshStandardMaterial({ color: hasFrame ? color : '#b7bfc1', roughness: 0.4, metalness: 0.12 }),
  );
  body.position.z = -d / 2;
  body.name = 'mirror-shaped-body';
  const geometry = new ShapeGeometry(outline(w - edge * 2, h - edge * 2, shape), 64),
    coords = geometry.getAttribute('position'),
    values: number[] = [];
  for (let i = 0; i < coords.count; i++) {
    const diagonal = coords.getX(i) / w + (coords.getY(i) - h / 2) / h,
      highlight = Math.exp(-Math.pow((diagonal - 0.18) / 0.38, 2)),
      c = new Color('#aeb8bd').lerp(new Color('#f2f5f5'), highlight * 0.7);
    values.push(c.r, c.g, c.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(values, 3));
  const face = new Mesh(
    geometry,
    new MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.3, metalness: 0.08 }),
  );
  face.position.set(0, edge, d / 2 + 0.001);
  face.name = 'mirror-neutral-shaped-face';
  return [body, face];
}
