import { prepareCloudGemmaPrompt } from './cloud-gemma-coordinates';
import { CLOUD_FIXTURE_CROP_PROMPT } from './cloud-fixture-crops';
import { fixtureAppearanceJsonSchemaFor, fixtureAppearancePrompt } from './fixture-appearance-observation';
import type { SceneUnderstanding } from './pipeline-contract';

export const CLOUD_GEMMA_APPEARANCE_METADATA = {
  providerAppearanceContract: 'gemma-fixed-candidate-appearance-v1',
  providerAppearancePromptRevision: 2,
} as const;

/** Exact common addition from the scope-only probe; no candidate labels or expected answers. */
export const CLOUD_GEMMA_APPEARANCE_SCOPE =
  'Target scope clarification for every provided candidate: in this task, the words fixture and target include all supported installed bathroom objects AND architectural elements in the supplied kind schema, not only sanitary equipment or basin/counter assemblies. Shelves, towel racks, windows, doors, mirror panels, storage cabinets, and dividers are within scope when their actual structure is visible. None is required to exist; do not discover new IDs or force a category merely because it is listed.\nUse context=physical for a directly visible supported object or architectural element; context=reflected only when the target itself is an image inside a reflecting surface; context=uncertain when that distinction is not established. context=not-fixture is for an unrelated non-target region such as bare wall, lighting/shadow, decoration or loose clutter, not for excluding a supported category from the task. kind=unknown means the visible evidence does not establish one supported kind; it is not a substitute for a supported kind merely because that kind is not a basin, cabinet, or sanitary fitting. An uncertain kind does not by itself mean that the region is non-physical or out of scope. Explain uncertainty without treating a prior label or this definition list as evidence.\nComplete supported-kind definitions, applied equally to all IDs: wall_basin = a washbasin attached to the wall with visible open space below, no full floor-reaching pedestal and no enclosing cabinet; pedestal_basin = a basin supported by a narrow pedestal reaching the floor; enclosed_vanity = a basin/counter storage assembly with visible enclosing cabinet body, doors or drawers beneath; open_counter_basin = a basin and supporting counter with visibly open space below instead of storage doors; mirror = the reflective panel itself; mirror_cabinet = mirror-front storage with visible cabinet body depth, door divisions or other storage structure; wall_cabinet = wall-mounted storage with a non-mirror cabinet body/front; glass_partition = a separate transparent or translucent divider with an identifiable panel boundary or supports; opaque_low_partition = a solid low wall or divider; shower = visibly installed shower head, hose, rail or control hardware, not unfinished pipework or loose temporary tubing; wall_shelf = an installed wall shelf, fixed projecting tray, towel shelf or towel rack, even if bottles or towels sit on it; door = a visibly present door leaf, including a partly visible leaf; door_frame_only = a frame or jamb with no visible door leaf, never evidence for inventing that leaf; window = an architectural opening with a visible window frame, sash or glazing, even when small, high or partly cropped; toilet = an identifiable toilet bowl/body or its visible assembly; bathtub = an identifiable bathing tub/basin enclosure; unknown = insufficient or ambiguous evidence for a supported kind. Keep the supplied IDs, evidence requirements, same-object rules and all other output fields unchanged. The photograph and ID crop board, not this category list, determine each result.';

export function requireCloudGemmaAppearanceContract(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Cloudflare 형태 관측의 공급자 계약이 없어요.');
  const input = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(CLOUD_GEMMA_APPEARANCE_METADATA))
    if (!Object.hasOwn(input, key) || input[key] !== expected)
      throw new Error('Cloudflare 형태 관측의 공급자 계약·프롬프트 버전이 달라요.');
}

/** Final provider prompt: preserve the tested envelope, crop instruction, then scope order. */
export function cloudGemmaFixtureAppearancePrompt(inventory: SceneUnderstanding): string {
  const basePrompt =
    fixtureAppearancePrompt(inventory) +
    '\n' +
    'For every observation also return pedestalShape: round, rectangular, or unknown. This is the cross-section of the visible floor-reaching pedestal support, independently of the basin bowl outline. Use round only for a visibly curved/cylindrical pedestal and rectangular only for visible flat faces/straight corners of that support. Never infer pedestalShape from shape, the bowl outline, or a product default. Only kind=pedestal_basin can have round or rectangular; use unknown for every other kind, or when the support is hidden, cropped or ambiguous. Explain the visible support evidence or uncertainty in note.';
  return (
    prepareCloudGemmaPrompt(basePrompt, 'appearance') +
    '\n' +
    CLOUD_FIXTURE_CROP_PROMPT +
    '\n' +
    CLOUD_GEMMA_APPEARANCE_SCOPE
  );
}

export function cloudGemmaFixtureAppearanceJsonSchemaFor(inventory: SceneUnderstanding) {
  const schema = fixtureAppearanceJsonSchemaFor(inventory);
  const row = schema.properties.observations.items;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      observations: {
        ...schema.properties.observations,
        items: {
          ...row,
          properties: {
            ...row.properties,
            pedestalShape: {
              type: 'string',
              enum: ['round', 'rectangular', 'unknown'],
              description:
                'Visible pedestal support cross-section, independent of the basin bowl. Use unknown unless kind is pedestal_basin and the support itself is visually identifiable.',
            },
          },
          required: [...row.required, 'pedestalShape'],
        },
      },
    },
  };
}
