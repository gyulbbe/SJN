import { getActiveDesign } from '../src/lib/designs';
import { describe, expect, it } from 'vitest';
import { restoreTileCoverageFromRaster, restorationDomain } from '../src/lib/render/restore-coverage';
import { maskContains, pointInPolygon, surfaceContains } from '../src/lib/render/mask';
import {
  DEFAULT_COLOR,
  DEFAULT_TILE,
  EMPTY_MASK,
  type LegacyProjectDocument as ProjectDocument,
  type Quad,
  type Scene,
  type Surface,
} from '../src/lib/types';
import { useEditor } from '../src/lib/editor-store';
import { projectSchema } from '../src/lib/supabase/validation';

const rect = (left: number, top: number, right: number, bottom: number): Quad => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];
function surface(kind: 'wall' | 'floor', quad: Quad): Surface {
  return {
    id: crypto.randomUUID(),
    kind,
    name: kind,
    quad,
    mask: {
      polygon: quad,
      holes: [rect(0.4, 0.3, 0.6, 0.9)],
      strokes: [{ points: [{ x: 0.5, y: 0.5 }], radius: 0.08, erase: true }],
    },
    widthMm: 2400,
    heightMm: 2000,
    calibrated: false,
    tile: { ...DEFAULT_TILE },
    color: { ...DEFAULT_COLOR },
  };
}
function scene(): Scene {
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    backgroundAssetId: crypto.randomUUID(),
    imageWidth: 100,
    imageHeight: 100,
    color: { ...DEFAULT_COLOR },
    surfaces: [surface('wall', rect(0, 0, 1, 0.6)), surface('floor', rect(0, 0.6, 1, 1))],
    protection: { polygon: rect(0, 0, 1, 1), strokes: [] },
    fixtures: [
      {
        id: crypto.randomUUID(),
        name: '독립 도기',
        materialVersionId: crypto.randomUUID(),
        viewIndex: 0,
        position: { x: 0.7, y: 0.8 },
        width: 0.15,
        height: 0.2,
        rotation: 0,
        anchor: { x: 0.5, y: 1 },
        locked: false,
        shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
        occlusion: EMPTY_MASK(),
        color: { ...DEFAULT_COLOR },
      },
    ],
  };
}
function selection(left = 0.45, top = 0.4, right = 0.55, bottom = 0.85) {
  const alpha = new Uint8Array(10000);
  for (let y = Math.round(top * 100); y < bottom * 100; y++)
    for (let x = Math.round(left * 100); x < right * 100; x++) alpha[y * 100 + x] = 255;
  return { width: 100, height: 100, alpha };
}
function document(value: Scene): ProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '복원',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 0,
    scene: value,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

describe('배경 복원 후 타일 연결', () => {
  it('선택한 벽과 바닥의 제품 구멍·이전 제외브러시를 복구하고 선택영역 보호만 해제한다', () => {
    const before = scene(),
      raster = selection();
    const after = restoreTileCoverageFromRaster(
      before,
      raster,
      before.surfaces.map((s) => s.id),
    );
    expect(surfaceContains(after.surfaces[0].mask, after.protection, { x: 0.5, y: 0.5 })).toBe(true);
    expect(surfaceContains(after.surfaces[1].mask, after.protection, { x: 0.5, y: 0.75 })).toBe(true);
    expect(maskContains(after.surfaces[0].mask, { x: 0.5, y: 0.75 })).toBe(false);
    expect(maskContains(after.surfaces[1].mask, { x: 0.5, y: 0.5 })).toBe(false);
    expect(maskContains(after.protection, { x: 0.42, y: 0.5 })).toBe(true);
  });

  it('선택 밖 모든 픽셀의 포함 여부와 기존 polygon·hole·stroke 참조가 그대로 유지된다', () => {
    const before = scene(),
      raster = selection();
    const after = restoreTileCoverageFromRaster(
      before,
      raster,
      before.surfaces.map((s) => s.id),
    );
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        if (raster.alpha[y * 100 + x]) continue;
        const p = { x: (x + 0.5) / 100, y: (y + 0.5) / 100 };
        for (let i = 0; i < before.surfaces.length; i++)
          expect(maskContains(after.surfaces[i].mask, p)).toBe(maskContains(before.surfaces[i].mask, p));
        expect(maskContains(after.protection, p)).toBe(maskContains(before.protection, p));
      }
    after.surfaces.forEach((s, i) => {
      expect(s.mask.polygon).toBe(before.surfaces[i].mask.polygon);
      expect(s.mask.holes).toBe(before.surfaces[i].mask.holes);
      expect(s.mask.strokes[0]).toBe(before.surfaces[i].mask.strokes[0]);
      expect(s.quad).toBe(before.surfaces[i].quad);
      expect(s.tile).toBe(before.surfaces[i].tile);
    });
    expect(after.fixtures).toBe(before.fixtures);
    expect(after.originalAssetId).toBe(before.originalAssetId);
    expect(after.backgroundAssetId).toBe(before.backgroundAssetId);
  });

  it('선택하지 않은 바닥에는 벽 타일을 연장하거나 보호를 해제하지 않는다', () => {
    const before = scene();
    const after = restoreTileCoverageFromRaster(before, selection(), [before.surfaces[0].id]);
    expect(after.surfaces[1]).toBe(before.surfaces[1]);
    expect(maskContains(after.protection, { x: 0.5, y: 0.75 })).toBe(true);
    expect(maskContains(after.surfaces[0].mask, { x: 0.5, y: 0.75 })).toBe(false);
  });

  it('정면/측벽 경계와 바닥 후면선을 넘어 다른 면을 채우지 않는다', () => {
    const value = scene();
    const left = surface('wall', [
      { x: 0, y: 0.2 },
      { x: 0.35, y: 0.1 },
      { x: 0.35, y: 0.6 },
      { x: 0, y: 0.9 },
    ]);
    const back = surface('wall', rect(0.35, 0.1, 0.65, 0.6));
    const right = surface('wall', [
      { x: 0.65, y: 0.1 },
      { x: 1, y: 0.2 },
      { x: 1, y: 0.9 },
      { x: 0.65, y: 0.6 },
    ]);
    const floor = surface('floor', [
      { x: 0.35, y: 0.6 },
      { x: 0.65, y: 0.6 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    value.surfaces = [left, back, right, floor];
    value.surfaces.forEach((s) => {
      s.mask.holes = [rect(0.2, 0.4, 0.8, 0.9)];
    });
    const after = restoreTileCoverageFromRaster(
      value,
      selection(0.25, 0.45, 0.75, 0.8),
      value.surfaces.map((s) => s.id),
    );
    for (const [index, point] of [
      [0, { x: 0.3, y: 0.5 }],
      [1, { x: 0.5, y: 0.5 }],
      [2, { x: 0.7, y: 0.5 }],
      [3, { x: 0.5, y: 0.7 }],
    ] as const) {
      expect(maskContains(after.surfaces[index].mask, point)).toBe(true);
      after.surfaces.forEach((s, i) => {
        if (i !== index) expect(maskContains(s.mask, point)).toBe(false);
      });
    }
  });

  it('측벽의 텍스처 기준 사각형 위에 보이는 실제 벽 영역도 보존한다', () => {
    const left = surface('wall', [
      { x: 0, y: 0.2 },
      { x: 0.35, y: 0.1 },
      { x: 0.35, y: 0.6 },
      { x: 0, y: 0.9 },
    ]);
    left.mask.polygon = [
      { x: 0, y: 0 },
      { x: 0.35, y: 0 },
      { x: 0.35, y: 0.6 },
      { x: 0, y: 0.9 },
    ];
    expect(pointInPolygon({ x: 0.1, y: 0.03 }, restorationDomain(left))).toBe(true);
  });

  it('반투명 경계·빈 선택·선택면 없음은 복구하지 않는다', () => {
    const before = scene(),
      raster = selection();
    raster.alpha.fill(254);
    expect(
      restoreTileCoverageFromRaster(
        before,
        raster,
        before.surfaces.map((s) => s.id),
      ),
    ).toBe(before);
    expect(restoreTileCoverageFromRaster(before, selection(), [])).toBe(before);
  });

  it('일반 브러시는 복원 polygon stroke 다음에도 정상적으로 제외·추가할 수 있다', () => {
    const before = scene();
    const after = restoreTileCoverageFromRaster(
      before,
      selection(),
      before.surfaces.map((s) => s.id),
    );
    const mask = after.surfaces[0].mask;
    mask.strokes.push({ points: [{ x: 0.5, y: 0.5 }], radius: 0.02, erase: true });
    expect(maskContains(mask, { x: 0.5, y: 0.5 })).toBe(false);
    mask.strokes.push({ points: [{ x: 0.5, y: 0.5 }], radius: 0.01, erase: false });
    expect(maskContains(mask, { x: 0.5, y: 0.5 })).toBe(true);
  });

  it('배경·마스크 변경을 한 명령으로 확정해 undo/redo하고 서버 문서검증도 통과한다', () => {
    const before = scene(),
      project = document(before);
    const restored = restoreTileCoverageFromRaster(
      before,
      selection(),
      before.surfaces.map((s) => s.id),
    );
    const backgroundAssetId = crypto.randomUUID();
    useEditor.getState().load(project);
    useEditor.getState().change((s) => {
      s.backgroundAssetId = backgroundAssetId;
      s.surfaces = restored.surfaces;
      s.protection = restored.protection;
    });
    expect(getActiveDesign(useEditor.getState().project!)!.history.past).toHaveLength(1);
    expect(projectSchema.safeParse(useEditor.getState().project).success).toBe(true);
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(before);
    useEditor.getState().redo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.backgroundAssetId).toBe(backgroundAssetId);
    expect(
      maskContains(getActiveDesign(useEditor.getState().project!)!.scene.protection, { x: 0.5, y: 0.5 }),
    ).toBe(false);
  });

  it('잘못된 래스터·사라진 대상과 점이 부족한 polygon stroke는 거부한다', () => {
    const value = scene();
    expect(() =>
      restoreTileCoverageFromRaster(value, { width: 100, height: 100, alpha: new Uint8Array(2) }, [
        value.surfaces[0].id,
      ]),
    ).toThrow();
    expect(() => restoreTileCoverageFromRaster(value, selection(), ['missing'])).toThrow();
    value.protection.strokes.push({ points: [{ x: 0.5, y: 0.5 }], radius: 0, erase: true });
    expect(projectSchema.safeParse(document(value)).success).toBe(false);
  });
});
