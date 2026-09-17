import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Vector3 } from 'three';
import { createLegacyLocalRepositories } from './helpers/legacy-local-repositories';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type LegacyProjectDocument,
  type Scene,
} from '../src/lib/types';
import { getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import { useEditor } from '../src/lib/editor-store';
import { makeAsset } from '../src/lib/images';
import {
  createReconstructionFixture,
  updateReconstructionFixture,
  type ReconstructionFixtureOptions,
} from '../src/lib/reconstruction';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { curtainHangingOffset } from '../src/lib/reconstruction/curtain-model';
import { reconstructionModelTransform, type VolumePlacement } from '../src/lib/reconstruction/projection';
import {
  inspectObservedInstallation,
  inspectObservedPlacement,
} from '../src/lib/reconstruction/observed-placement';
import { validateSourceFixture } from '../src/lib/reconstruction/source-camera';
import {
  parseSceneUnderstanding,
  validateUserUnderstanding,
} from '../src/lib/reconstruction/scene-understanding';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { CurtainHardware, ReconstructionReview } from '../src/lib/reconstruction/types';
import { projectV3Schema } from '../src/lib/storage/validation';

// Only WebGL rasterization and browser bitmap/canvas readback are synthetic. Model geometry,
// placement, material/version creation, editor history, local repository and schemas are real.
const raster = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../src/lib/reconstruction/templates', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/templates')>()),
  renderReconstructionTemplate: raster.render,
}));
const room = { ...DEFAULT_ROOM, widthMm: 2400, depthMm: 2400, heightMm: 2400 };
const plan = {
  kind: 'showerCurtain' as const,
  version: 2 as const,
  room,
  face: 'floor' as const,
  widthMm: 881,
  heightMm: 1822,
  depthMm: 48,
  baseHeightMm: 210,
  u: 0.43,
  v: 0.55,
  yawDegrees: 37,
  color: '#ddd8c8',
  aspect: 1,
  placementPolicy: 'preserve' as const,
};
function blob() {
  return new Blob(['synthetic raster bytes; not a photo or AI result'], { type: 'image/png' });
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  raster.render.mockReset().mockImplementation(async () => ({ blob: blob(), anchor: { x: 0.5, y: 1 } }));
  network = vi.fn(() => {
    throw new Error('No external or AI request is allowed in this integration test');
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 16, height: 16, close() {} })),
  );
  vi.stubGlobal('document', {
    createElement(name: string) {
      if (name !== 'canvas') throw new Error('Unexpected browser surface: ' + name);
      return {
        width: 16,
        height: 16,
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              return { data: new Uint8ClampedArray(16 * 16 * 4).fill(255) };
            },
          };
        },
      };
    },
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function repos(databaseName = 'curtain-integration-' + crypto.randomUUID()) {
  return createLegacyLocalRepositories(databaseName);
}
function candidate(): SceneCandidate {
  return {
    id: 'curtain_observation',
    kind: 'showerCurtain',
    mounting: 'suspended',
    wall: 'unknown',
    basinStyle: 'unknown',
    shape: 'unknown',
    reflection: 'physical',
    bounds: { left: 0.2, top: 0.1, right: 0.6, bottom: 0.9 },
    evidence: ['Synthetic support contract'],
    uncertainty: [],
  };
}
function baseline(c = candidate()): ReconstructionReview {
  return {
    version: 2,
    analysis: 'partial',
    planes: [],
    warnings: [],
    candidates: [
      {
        id: 'semantic_fixture',
        kind: c.kind === 'unknown' ? 'toilet' : c.kind,
        source: 'deeplab',
        bounds: { ...c.bounds },
        foot: { x: 0.4, y: c.bounds.bottom },
        color: '#cccccc',
        pixels: 1000,
        evidence: { semanticPixels: 1000, meanMargin: 3 },
        status: 'unplaced',
        installation: { mode: 'suspended', source: 'inferred', reason: 'Preserved suspension evidence' },
      },
    ],
  };
}
function physical(fixture: FixtureInstance): VolumePlacement {
  return {
    ...fixture.reconstruction!,
    ...fixture.roomPlacement!,
    kind: fixture.reconstruction!.kind,
    depthMm: fixture.reconstruction!.depthMm,
  };
}
async function project(repository: ReturnType<typeof repos>, fixture: FixtureInstance) {
  const original = await makeAsset(blob(), 'source-original.png', 'original');
  const preview = await makeAsset(blob(), 'source-preview.png', 'preview', original.id);
  await repository.assets.put(original);
  await repository.assets.put(preview);
  const before: Scene = {
    room,
    originalAssetId: original.id,
    previewAssetId: preview.id,
    imageWidth: 16,
    imageHeight: 16,
    surfaces: createRoomSurfaces(room, 1),
    fixtures: [fixture],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  const after = { ...structuredClone(before), fixtures: [] };
  const value: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: 'Isolated curtain integration',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scene: after,
    comparison: {
      before,
      room,
      cameraVersion: 1,
      aspect: 1,
      referenceOriginalAssetId: original.id,
      referencePreviewAssetId: preview.id,
      status: 'draft',
    },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
  };
  return { value: await repository.projects.create(normalizeProjectDocument(value)), original, preview };
}

describe('suspended curtains: real factory, physical placement, editor and local storage; mocked pixels only', () => {
  it.each(['suspended', 'unknown', 'floor'] as const)(
    'holds strict %s support without converting image bottom into a floor contact',
    (mounting) => {
      const c = { ...candidate(), mounting };
      const b = baseline(c);
      const copy = structuredClone({ c, b });
      const placement = inspectObservedPlacement(c, [c], b, room);
      const installation = inspectObservedInstallation(c, [c], b);
      for (const result of [placement, installation]) {
        expect(result.diagnostic.status).toBe('held');
        expect(result.diagnostic.code).toBe('suspended-anchor-unobserved');
        expect(result.diagnostic.message).toContain('바닥 접점');
      }
      expect(placement.placement).toBeUndefined();
      expect(installation.installation).toBeUndefined();
      expect({ c, b }).toEqual(copy);
    },
  );
  it('also refuses a suspended baseline installation when the current candidate has no mounting yet', () => {
    const c: SceneCandidate = { ...candidate(), kind: 'toilet', mounting: 'unknown' };
    const b = baseline(c);
    const copy = structuredClone(b);
    for (const result of [
      inspectObservedPlacement(c, [c], b, room),
      inspectObservedInstallation(c, [c], b),
    ]) {
      expect(result.diagnostic.code).toBe('suspended-anchor-unobserved');
      expect(result.diagnostic.baselineCandidateId).toBe('semantic_fixture');
      expect(result.diagnostic.details).toContain('Preserved suspension evidence');
    }
    expect(b).toEqual(copy);
  });
  it.each(['rod', 'track', 'none'] as CurtainHardware[])(
    'creates %s hardware with the requested whole envelope and suspended material semantics',
    async (curtainHardware) => {
      const repository = repos();
      const created = await createReconstructionFixture({
        ...plan,
        curtainHardware,
        repositories: repository,
      });
      const p = physical(created);
      const check = validateSourceFixture(room, undefined, p);
      expect(check.valid).toBe(true);
      expect(check.reasons).toEqual([]);
      expect(created.roomPlacement).toMatchObject({ face: 'floor', u: plan.u, v: plan.v, scale: 1 });
      expect(created.reconstruction).toMatchObject({
        kind: 'showerCurtain',
        version: 2,
        widthMm: 881,
        heightMm: 1822,
        depthMm: 48,
        baseHeightMm: 210,
        yawDegrees: 37,
        color: '#ddd8c8',
        curtainHardware,
      });
      const version = await repository.materials.getVersion(created.materialVersionId);
      expect(version).toMatchObject({
        category: 'showerCurtain',
        installation: 'suspended',
        widthMm: 881,
        heightMm: 1822,
        depthMm: 48,
        reconstruction: { kind: 'showerCurtain', version: 2 },
      });
      expect(version.pricing).toBeUndefined();
      const model = createTemplateModel({ ...plan, curtainHardware });
      try {
        const box = new Box3().setFromObject(model, true);
        const size = box.getSize(new Vector3());
        expect(size.x).toBeCloseTo(881, 2);
        expect(size.y).toBeCloseTo(1822, 2);
        expect(size.z).toBeCloseTo(48, 2);
        expect(box.min.y).toBeCloseTo(0, 3);
        const anchor = new Vector3(...(model.userData.hangingAnchor as [number, number, number]));
        expect(anchor.y).toBeCloseTo(curtainHangingOffset(1822, curtainHardware), 3);
        const transform = reconstructionModelTransform(room, p);
        const hanging = anchor
          .multiplyScalar(transform.scale)
          .applyAxisAngle(new Vector3(0, 1, 0), transform.angle)
          .add(transform.origin);
        expect(hanging.y).toBeGreaterThan(210);
        expect(check.worldBoundsMm!.min[1]).toBeCloseTo(210, 2);
        expect(check.worldBoundsMm!.max[1]).toBeCloseTo(2032, 2);
        expect(hanging.y).toBeLessThanOrEqual(check.worldBoundsMm!.max[1] + 0.01);
        expect(model.userData.curtainModel.anchorMeaning).toBe('hanging-support-centre');
      } finally {
        disposeTemplateModel(model);
      }
    },
  );
  it.each([
    { version: 1 },
    { face: 'back' },
    { depthMm: 0 },
    { curtainHardware: 'wire' },
    { u: 0 },
    { widthMm: 4000 },
    { baseHeightMm: 1000 },
    { heightMm: 3000 },
  ])(
    'rejects invalid or overflowing explicit input %j before making assets or material versions',
    async (patch) => {
      const repository = repos();
      const addAsset = vi.spyOn(repository.assets, 'put');
      const addVersion = vi.spyOn(repository.materials, 'create');
      await expect(
        createReconstructionFixture({
          ...plan,
          ...patch,
          repositories: repository,
        } as ReconstructionFixtureOptions),
      ).rejects.toThrow();
      expect(raster.render).not.toHaveBeenCalled();
      expect(addAsset).not.toHaveBeenCalled();
      expect(addVersion).not.toHaveBeenCalled();
      expect(await repository.materials.list()).toEqual([]);
    },
  );
  it('allows a floating suspended envelope but still rejects an unsupported floating floor fixture', () => {
    expect(validateSourceFixture(room, undefined, plan).valid).toBe(true);
    const glass = { ...plan, kind: 'glassPartition' };
    expect(validateSourceFixture(room, undefined, glass).valid).toBe(false);
    expect(validateSourceFixture(room, undefined, glass).reasons.join(' ')).toContain('바닥에 닿지');
    expect(validateSourceFixture(room, undefined, { ...plan, u: 0 }).overflowMm!.left).toBeGreaterThan(1);
  });
  it('changes hardware through factory/editor/undo/redo/save/re-entry while retaining source bytes and old immutable versions', async () => {
    const databaseName = 'curtain-reopen-' + crypto.randomUUID();
    const repository = repos(databaseName);
    const first = await createReconstructionFixture({
      ...plan,
      curtainHardware: 'rod',
      repositories: repository,
    });
    const version = await repository.materials.getVersion(first.materialVersionId);
    const sourceAsset = await repository.assets.get(version.views[0].assetId);
    const oldBytes = await sourceAsset.blob.text();
    const firstCopy = structuredClone(first);
    const { value, original, preview } = await project(repository, first);
    useEditor.getState().load(value);
    useEditor.getState().setEditing('before');
    const next = await updateReconstructionFixture(
      first,
      room,
      {
        curtainHardware: 'track',
        provenance: { ...first.reconstruction!.provenance, curtainHardware: 'user' },
      },
      { repositories: repository },
    );
    expect(next.id).toBe(first.id);
    expect(next.materialVersionId).not.toBe(first.materialVersionId);
    expect(next.roomPlacement).toEqual(first.roomPlacement);
    expect(next.reconstruction).toMatchObject({
      widthMm: 881,
      heightMm: 1822,
      depthMm: 48,
      baseHeightMm: 210,
      yawDegrees: 37,
    });
    useEditor.getState().preview((scene) => {
      scene.fixtures[0] = next;
    });
    useEditor.getState().commit();
    const changed = structuredClone(useEditor.getState().project!);
    expect(changed.shared.comparison!.before.fixtures[0].reconstruction!.curtainHardware).toBe('track');
    expect(getActiveDesign(changed)!.scene.fixtures).toEqual([]);
    useEditor.getState().undo();
    expect(useEditor.getState().project!.shared.comparison!.before.fixtures[0]).toEqual(first);
    useEditor.getState().redo();
    expect(useEditor.getState().project!.shared.comparison!.before.fixtures[0]).toEqual(next);
    const saved = await repository.projects.save(useEditor.getState().project!, value.storageRevision);
    const reopened = createLegacyLocalRepositories(databaseName);
    expect(reopened.mode).toBe('local');
    const loaded = await reopened.projects.load(saved.id);
    useEditor.getState().load(loaded);
    expect(
      projectV3Schema.parse(loaded).shared.comparison!.before.fixtures[0].reconstruction!.curtainHardware,
    ).toBe('track');
    expect(loaded.shared.beforeHistory.past).toHaveLength(1);
    expect(getActiveDesign(loaded)!.scene.fixtures).toEqual([]);
    expect(loaded.shared.comparison!.room).toEqual(room);
    expect(loaded.shared.comparison!.aspect).toBe(1);
    expect(await repository.materials.getVersion(first.materialVersionId)).toEqual(version);
    expect(await (await repository.assets.get(sourceAsset.id)).blob.text()).toBe(oldBytes);
    expect(await (await repository.assets.get(original.id)).blob.text()).toBe(await original.blob.text());
    expect((await repository.assets.get(preview.id)).sourceAssetId).toBe(original.id);
    expect(first).toEqual(firstCopy);
    expect(getActiveDesign(loaded)!.quote).toBeUndefined();
  });
  it('clears curtain-only options and provenance on an explicit kind change while preserving unrelated user fields', async () => {
    const repository = repos();
    const first = await createReconstructionFixture({
      ...plan,
      curtainHardware: 'rod',
      provenance: { curtainHardware: 'user', width: 'user' },
      repositories: repository,
    });
    const version = await repository.materials.getVersion(first.materialVersionId);
    const changed = await updateReconstructionFixture(
      first,
      room,
      { kind: 'glassPartition', baseHeightMm: 0 },
      { repositories: repository },
    );
    expect(changed.reconstruction!.curtainHardware).toBeUndefined();
    expect(changed.reconstruction!.provenance!.curtainHardware).toBeUndefined();
    expect(changed.reconstruction!.provenance!.width).toBe('user');
    expect(changed.reconstruction!.kind).toBe('glassPartition');
    expect((await repository.materials.getVersion(changed.materialVersionId)).installation).toBe('floor');
    expect(await repository.materials.getVersion(first.materialVersionId)).toEqual(version);
  });
  it('converts an existing v1 standard fixture only explicitly and preserves its prior material source', async () => {
    const repository = repos();
    const first = await createReconstructionFixture({
      ...plan,
      kind: 'glassPartition',
      version: 1,
      baseHeightMm: 0,
      repositories: repository,
    });
    const version = await repository.materials.getVersion(first.materialVersionId);
    expect(first.reconstruction!.curtainHardware).toBeUndefined();
    const next = await updateReconstructionFixture(
      first,
      room,
      { kind: 'showerCurtain', curtainHardware: 'none', baseHeightMm: 210 },
      { repositories: repository, convertToStandard: true },
    );
    expect(next.reconstruction).toMatchObject({
      version: 2,
      kind: 'showerCurtain',
      curtainHardware: 'none',
      sourceMaterialVersionId: first.materialVersionId,
    });
    expect(await repository.materials.getVersion(first.materialVersionId)).toEqual(version);
    expect(first.reconstruction!.version).toBe(1);
  });
  it('accepts internal/user-confirmed curtain observations without broadening raw model acceptance or inventing an anchor', () => {
    const c = candidate();
    const raw = {
      schemaVersion: 1,
      candidates: [{ ...c, anchor: null }],
      relations: [],
      roomLayout: {
        orthogonal: 'unknown',
        backWallQuad: null,
        evidence: [],
        uncertainty: [],
        lines: [],
        corners: [],
      },
    };
    expect(() => parseSceneUnderstanding(JSON.stringify(raw))).toThrow();
    const internal = parseSceneUnderstanding(JSON.stringify(raw), { internal: true });
    expect(internal.candidates[0]).toMatchObject({ kind: 'showerCurtain', mounting: 'suspended' });
    expect(internal.candidates[0].anchor).toBeUndefined();
    const automatic: SceneUnderstanding = {
      ...internal,
      candidates: [{ ...c, kind: 'glassPartition', mounting: 'floor' }],
    };
    const original = structuredClone(automatic);
    const confirmed = validateUserUnderstanding(internal, automatic);
    expect(confirmed.candidates[0].provenance).toMatchObject({ kind: 'user', mounting: 'user' });
    expect(confirmed.candidates[0].bounds).toEqual(c.bounds);
    expect(automatic).toEqual(original);
    const invalid = {
      ...raw,
      candidates: [
        {
          ...raw.candidates[0],
          anchor: {
            point: { x: 0.4, y: 0.9 },
            kind: 'floor-contact',
            evidence: ['Synthetic invalid contact'],
            uncertainty: [],
          },
        },
      ],
    };
    const held = parseSceneUnderstanding(JSON.stringify(invalid), { internal: true });
    expect(held.candidates[0].validation?.issues.some((issue) => issue.code === 'anchor-mounting')).toBe(
      true,
    );
  });
  it('cancels before rasterization or immutable writes', async () => {
    const repository = repos();
    const signal = AbortSignal.abort();
    await expect(
      createReconstructionFixture({ ...plan, repositories: repository, signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(raster.render).not.toHaveBeenCalled();
    expect(await repository.materials.list()).toEqual([]);
  });
});
