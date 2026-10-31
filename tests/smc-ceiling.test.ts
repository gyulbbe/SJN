import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveDesign } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { buildFluxPrompt, ceilingSentence } from '../src/lib/ai-export/prompt';
import { fluxSceneSchema } from '../src/lib/ai-export/scene-contract';
import { calculateMaterialUsage } from '../src/lib/material-usage';
import { partitionRoomFaces } from '../src/lib/room-face-partition';
import { resizedRoomScene, roomResetWarnings } from '../src/lib/room-editing';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { validateQuad } from '../src/lib/render/math';
import {
  ceilingLampBounds,
  ceilingQuad,
  ceilingToolIssue,
  roomOpeningQuad,
  SMC_CEILING_IMAGE,
  smcCeilingImage,
  toggleCeiling,
  toggleCeilingLight,
} from '../src/lib/smc-ceiling';
import { projectV3Schema } from '../src/lib/storage/validation';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type ProjectDocument,
  type Scene,
} from '../src/lib/types';

function scene(): Scene {
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function project(): LegacyProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: 'SMC 천장',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 1,
    scene: scene(),
    comparison: {
      before: scene(),
      room: { ...DEFAULT_ROOM },
      aspect: 1.5,
      cameraVersion: 1,
      referenceOriginalAssetId: crypto.randomUUID(),
      referencePreviewAssetId: crypto.randomUUID(),
      status: 'draft',
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}
const after = () => getActiveDesign(useEditor.getState().project!)!.scene;
const stored = () => structuredClone(useEditor.getState().project!) as ProjectDocument;
const messages = (value: unknown) =>
  projectV3Schema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe('the SMC ceiling in a design', () => {
  beforeEach(() => useEditor.getState().load(project()));

  it('turns on with its light, the light turns alone, and off leaves the scene as it was', () => {
    const plain = JSON.stringify(after());
    const pastBefore = stored().designs[0].history?.past.length ?? 0;
    useEditor.getState().change(toggleCeiling);
    expect(after().ceiling).toEqual({ kind: 'smc', light: true });
    useEditor.getState().change(toggleCeilingLight);
    expect(after().ceiling).toEqual({ kind: 'smc', light: false });
    expect(projectV3Schema.safeParse(stored()).success).toBe(true);
    useEditor.getState().change(toggleCeiling);
    expect(after().ceiling).toBeUndefined();
    expect('ceiling' in after()).toBe(false);
    expect(JSON.stringify(after())).toBe(plain);
    // One history step each: undo walks back through off, the dark light and on.
    useEditor.getState().undo();
    expect(after().ceiling).toEqual({ kind: 'smc', light: false });
    useEditor.getState().undo();
    expect(after().ceiling).toEqual({ kind: 'smc', light: true });
    useEditor.getState().undo();
    expect(after().ceiling).toBeUndefined();
    expect(stored().designs[0].history?.past.length ?? 0).toBe(pastBefore);
    useEditor.getState().redo();
    expect(after().ceiling).toEqual({ kind: 'smc', light: true });
  });

  it('is saved on After designs of a room only, and an old document still reads', () => {
    expect(projectV3Schema.safeParse(stored()).success).toBe(true);
    useEditor.getState().change(toggleCeiling);
    const valid = stored();
    expect(projectV3Schema.safeParse(valid).success).toBe(true);
    const onBefore = structuredClone(valid);
    onBefore.shared.comparison!.before.ceiling = { kind: 'smc', light: true };
    expect(messages(onBefore)).toContain('SMC 천장은 After 시안에만 둘 수 있어요.');
    const onBaseline = structuredClone(valid);
    onBaseline.shared.baseline.ceiling = { kind: 'smc', light: true };
    expect(messages(onBaseline)).toContain('SMC 천장은 After 시안에만 둘 수 있어요.');
    const strange = structuredClone(valid) as unknown as { designs: { scene: { ceiling: unknown } }[] };
    strange.designs[0].scene.ceiling = { kind: 'tile', light: true };
    expect(projectV3Schema.safeParse(strange).success).toBe(false);
    strange.designs[0].scene.ceiling = { kind: 'smc', light: true, price: 1 };
    expect(projectV3Schema.safeParse(strange).success).toBe(false);
    const roomless = structuredClone(valid);
    delete roomless.designs[0].scene.room;
    expect(messages(roomless)).toContain('SMC 천장은 방 치수가 있는 공간에서만 쓸 수 있어요.');
  });

  it('copies with its design, a new design has none, and it stays in Before-free design lists', () => {
    useEditor.getState().change(toggleCeiling);
    const copy = useEditor.getState().copyDesign()!;
    expect(useEditor.getState().project!.designs.find((d) => d.id === copy)!.scene.ceiling).toEqual({
      kind: 'smc',
      light: true,
    });
    const blank = useEditor.getState().createDesign('새 시안')!;
    expect(useEditor.getState().project!.designs.find((d) => d.id === blank)!.scene.ceiling).toBeUndefined();
    expect(projectV3Schema.safeParse(stored()).success).toBe(true);
  });

  it('says why it cannot be used', () => {
    const base = { scene: scene(), editing: 'after', writable: true, mode: 'after' } as const;
    expect(ceilingToolIssue(base)).toBeNull();
    expect(ceilingToolIssue({ ...base, scene: { room: undefined } })).toContain('방 치수');
    expect(ceilingToolIssue({ ...base, editing: 'before' })).toContain('After');
    expect(ceilingToolIssue({ ...base, writable: false })).toContain('읽기 전용');
    expect(ceilingToolIssue({ ...base, mode: 'split' })).toContain('비교 보기');
  });
});

describe('what the ceiling leaves alone', () => {
  const on: Scene = { ...scene(), ceiling: { kind: 'smc', light: true } };
  const off: Scene = { ...on, ceiling: undefined };

  it('is no surface: face cells and usage are the same with or without it', () => {
    expect(partitionRoomFaces(on).faces.map((face) => face.cells.length)).toEqual(
      partitionRoomFaces(off).faces.map((face) => face.cells.length),
    );
    expect(partitionRoomFaces(on).faces.map((face) => face.face)).toEqual(['floor', 'left', 'back', 'right']);
    const material = {};
    expect(calculateMaterialUsage(on, material).rows).toEqual(calculateMaterialUsage(off, material).rows);
  });

  it('stays through a resize with no new warning', () => {
    const room = { ...DEFAULT_ROOM, widthMm: 3600 };
    const resized = resizedRoomScene(on, room, {
      originalAssetId: 'new',
      previewAssetId: 'new-preview',
      imageWidth: 1500,
      imageHeight: 1000,
    });
    expect(resized.ceiling).toEqual({ kind: 'smc', light: true });
    expect(roomResetWarnings(on, room)).toEqual(roomResetWarnings(off, room));
  });

  it('sits in the frame as one convex quad, its panel inside it', () => {
    for (const room of [
      DEFAULT_ROOM,
      { ...DEFAULT_ROOM, widthMm: 1500, depthMm: 1500 },
      { ...DEFAULT_ROOM, widthMm: 6000, depthMm: 2000, heightMm: 3000 },
    ]) {
      const quad = ceilingQuad(room, 1.5);
      expect(validateQuad(quad)).toBe(true);
      for (const point of quad) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThan(0.5);
      }
      expect(validateQuad(roomOpeningQuad(room, 1.5))).toBe(true);
      const [left, top, right, bottom] = ceilingLampBounds(room);
      expect(left).toBeGreaterThan(0);
      expect(right).toBeLessThan(1);
      expect(top).toBeGreaterThan(0);
      expect(bottom).toBeLessThan(1);
    }
  });
});

describe('the ceiling picture', () => {
  it('leaves the colour when it cannot be read, and the next ceiling tries again', async () => {
    const failed = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', failed);
    await expect(smcCeilingImage()).resolves.toBeNull();
    await expect(smcCeilingImage()).resolves.toBeNull();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledWith(SMC_CEILING_IMAGE);
    vi.unstubAllGlobals();
  });
});

describe('the AI sentence', () => {
  const plain = { version: 1 as const, fixtures: [], surfaces: [] };
  const paint = { color: '#f3f2ee', light: 'flat-panel' as const };
  const lit = { color: '#ece7da', light: 'flat-panel' as const, material: 'smc' as const };
  const dark = { color: '#ece7da', light: 'none' as const, material: 'smc' as const };

  it('names the SMC ceiling with or without its panel, never the paint', () => {
    expect(ceilingSentence(lit)).toMatch(/SMC bathroom ceiling with one flat square light panel\.$/);
    expect(ceilingSentence(dark)).toMatch(/SMC bathroom ceiling with no light fixture\.$/);
    for (const ceiling of [lit, dark]) {
      const prompt = buildFluxPrompt({ ...plain, ceiling });
      expect(prompt).toContain('SMC');
      expect(prompt).not.toContain('paint with one flat');
      expect(fluxSceneSchema.safeParse({ ...plain, ceiling }).success).toBe(true);
    }
  });

  it('leaves the older sentence and an older request as they were', () => {
    expect(ceilingSentence(paint)).toMatch(
      /^The ceiling is plain .* paint with one flat square light panel\.$/,
    );
    expect(fluxSceneSchema.safeParse({ ...plain, ceiling: paint }).success).toBe(true);
    expect(buildFluxPrompt(plain)).not.toContain('SMC');
    expect(fluxSceneSchema.safeParse({ ...plain, ceiling: { ...lit, material: 'tile' } }).success).toBe(
      false,
    );
  });
});
