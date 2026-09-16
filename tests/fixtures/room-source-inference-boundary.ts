/** TEST ONLY: authored inference boundary. No AI execution, model download, or accuracy claim. */
import { LAB_QWEN_MODEL } from '../../src/lib/reconstruction/lab-engine';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  parseFixtureInventory,
} from '../../src/lib/reconstruction/inventory-observation';
import { skippedIdentityAnalysis } from '../../src/lib/reconstruction/identity-observation';
import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  parseInstallationObservation,
} from '../../src/lib/reconstruction/installation-observation';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
} from '../../src/lib/reconstruction/fixture-appearance-observation';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  parseLayoutObservation,
} from '../../src/lib/reconstruction/layout-observation';
import {
  LOCAL_GEOMETRY_MODEL,
  LOCAL_GEOMETRY_MODEL_REVISION,
  LOCAL_GEOMETRY_REVISION,
  type LocalGeometryAnalysis,
} from '../../src/lib/reconstruction/geometry-contract';
import type { SceneUnderstanding } from '../../src/lib/reconstruction/pipeline-contract';
export const boundaryCalls: string[] = [];
const mark = (name: string) => boundaryCalls.push(name);
const hash = async (blob: Blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
async function meta(photo: Blob) {
  const bitmap = await createImageBitmap(photo);
  const result = {
    modelId: LAB_QWEN_MODEL,
    modelRevision: 'b'.repeat(64),
    photoFingerprint: await hash(photo),
    measurement: {
      requestMs: 0,
      inputWidth: bitmap.width,
      inputHeight: bitmap.height,
      memoryScope: 'Authored inference contract boundary. No AI.',
      modelDownload: 'not-performed-cached-model-required' as const,
    },
  };
  bitmap.close();
  return result;
}
export async function analyzeExtendedScene(photo: Blob) {
  mark('inventory');
  const rawText = JSON.stringify({
    items: [
      {
        kind: 'toilet',
        bbox_2d: [520, 480, 830, 900],
        view: 'direct',
        basin: null,
        note: 'Authored test observation: one floor toilet, not a detector result.',
      },
    ],
  });
  return {
    ...(await meta(photo)),
    ...parseFixtureInventory(rawText, EXTENDED_INVENTORY_OUTPUT_CONTRACT),
    rawText,
    outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
    promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
  };
}
export const analyzeScene = analyzeExtendedScene;
export async function analyzeIdentity(_photo: Blob, inventory: SceneUnderstanding) {
  mark('identity');
  return skippedIdentityAnalysis(inventory);
}
export async function analyzeInstallation(photo: Blob, inventory: SceneUnderstanding) {
  mark('installation');
  const rawText = JSON.stringify({
    observations: inventory.candidates.map((c) => ({
      id: c.id,
      note: 'Authored test: floor contact visible. Not real inference.',
      lower_support: 'full_base_on_floor',
      wall_connection: 'not_visible',
    })),
  });
  return {
    ...(await meta(photo)),
    ...parseInstallationObservation(rawText, inventory, INSTALLATION_OUTPUT_CONTRACT),
    rawText,
    outputContract: INSTALLATION_OUTPUT_CONTRACT,
    promptRevision: INSTALLATION_PROMPT_REVISION,
  };
}
export async function analyzeFixtureAppearance(photo: Blob, inventory: SceneUnderstanding) {
  mark('appearance');
  const rawText = JSON.stringify({
    schemaVersion: 1,
    observations: inventory.candidates.map((c) => ({
      id: c.id,
      note: 'Authored test observation: standard toilet. Not real inference.',
      kind: 'toilet',
      context: 'physical',
      sameObjectAs: null,
      shape: 'unknown',
      counterSupport: 'unknown',
    })),
  });
  return {
    ...(await meta(photo)),
    ...parseFixtureAppearance(rawText, inventory),
    rawText,
    outputContract: FIXTURE_APPEARANCE_CONTRACT,
    promptRevision: FIXTURE_APPEARANCE_PROMPT_REVISION,
  };
}
export async function analyzeLayout(photo: Blob, inventory: SceneUnderstanding) {
  mark('layout');
  const rawText = JSON.stringify({
    observations: inventory.candidates.map((c) => ({
      id: c.id,
      wall: 'back',
      orientation: 'toward-camera',
      note: 'Authored test observation for common camera integration.',
    })),
    relations: [],
  });
  return {
    ...(await meta(photo)),
    ...parseLayoutObservation(rawText, inventory),
    rawText,
    outputContract: LAYOUT_OUTPUT_CONTRACT,
    promptRevision: LAYOUT_PROMPT_REVISION,
  };
}
export async function analyzeGeometry(photo: Blob): Promise<LocalGeometryAnalysis> {
  mark('geometry');
  const m = await meta(photo),
    fingerprint = m.photoFingerprint;
  return {
    inputFingerprint: fingerprint,
    observation: {
      version: 1,
      inputFingerprint: fingerprint,
      image: { width: m.measurement.inputWidth, height: m.measurement.inputHeight },
      model: { id: LOCAL_GEOMETRY_MODEL, revision: LOCAL_GEOMETRY_MODEL_REVISION },
      coordinateSystem: 'opencv-camera',
      scale: 'model-estimated-metres',
      intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
      floor: null,
      walls: [],
    },
    measurement: {
      requestMs: 0,
      modelLoadMs: 0,
      inferenceMs: 0,
      planeExtractionMs: 0,
      cacheHit: false,
      modelCacheHit: true,
      modelDownload: 'not-performed-cached-model-required',
      memoryScope: 'Authored inference contract boundary. No AI.',
    },
    evidence: { revision: LOCAL_GEOMETRY_REVISION },
  };
}
export async function segmentRoom() {
  mark('segmentation');
  const width = 64,
    height = 64,
    wall = new Uint8Array(width * height),
    floor = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (y < 45) wall[y * width + x] = 255;
      else floor[y * width + x] = 255;
    }
  return { width, height, wall, floor, objects: [] };
}
