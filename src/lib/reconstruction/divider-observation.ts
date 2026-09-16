import { z } from 'zod';
import type { SceneUnderstanding } from './pipeline-contract';

export const DIVIDER_OBSERVATION_CONTRACT = 'fixed-candidate-divider-material-v1' as const;
export const DIVIDER_OBSERVATION_PROMPT_REVISION = 1;
const materials = ['fabric-curtain', 'rigid-glass', 'solid-wall', 'mixed-or-unclear', 'not-divider'] as const;
const contexts = ['physical', 'reflected', 'uncertain'] as const;
const extents = ['whole', 'part', 'multiple', 'unknown'] as const;
const supports = ['rod', 'track', 'frame', 'unknown'] as const;
export type DividerTarget = {
  readonly id: string;
  readonly bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
};
const targetSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => value.trim().length > 0),
  bounds: z
    .strictObject({
      left: z.number().finite().min(0).max(1),
      top: z.number().finite().min(0).max(1),
      right: z.number().finite().min(0).max(1),
      bottom: z.number().finite().min(0).max(1),
    })
    .refine((b) => b.left < b.right && b.top < b.bottom),
});
/** Validate and copy; equal boxes with distinct IDs remain separate targets. */
export function validateDividerTargets(targets: readonly DividerTarget[]): DividerTarget[] {
  const values = z.array(targetSchema).min(1).max(24).parse(targets);
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new Error('칸막이 재질 관측 대상 ID가 중복돼요.');
  return values.map((value) => ({
    id: value.id,
    bounds: {
      left: value.bounds.left,
      top: value.bounds.top,
      right: value.bounds.right,
      bottom: value.bounds.bottom,
    },
  }));
}
/** Selection policy is external; this boundary only verifies the exact observed IDs and boxes. */
export function validateDividerTargetsForInventory(
  inventory: SceneUnderstanding,
  targets: readonly DividerTarget[],
) {
  const fixed = validateDividerTargets(targets),
    candidates = new Map(inventory.candidates.map((value) => [value.id, value]));
  if (candidates.size !== inventory.candidates.length) throw new Error('원후보 ID가 중복돼요.');
  for (const target of fixed) {
    const candidate = candidates.get(target.id);
    if (
      !candidate ||
      (['left', 'top', 'right', 'bottom'] as const).some(
        (key) => candidate.bounds[key] !== target.bounds[key],
      )
    )
      throw new Error('칸막이 관측 ID·영역이 원후보와 달라요.');
  }
  return fixed;
}
export function dividerTargetsSignature(targets: readonly DividerTarget[]) {
  return JSON.stringify(validateDividerTargets(targets));
}
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
/** Same hand-built schema and property order as the frozen, actually executed v1 experiment. */
export function dividerObservationJsonSchemaFor(targets: readonly DividerTarget[]) {
  const fixed = validateDividerTargets(targets);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      observations: {
        type: 'array',
        minItems: fixed.length,
        maxItems: fixed.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: enumeration(fixed.map((t) => t.id)),
            note: { type: 'string', minLength: 1, maxLength: 800 },
            context: enumeration(contexts),
            dividerMaterial: enumeration(materials),
            visibleExtent: enumeration(extents),
            support: enumeration(supports),
          },
          required: ['id', 'note', 'context', 'dividerMaterial', 'visibleExtent', 'support'],
        },
      },
    },
    required: ['schemaVersion', 'observations'],
  };
}
export function dividerObservationPrompt(targets: readonly DividerTarget[]) {
  const fixed = validateDividerTargets(targets);
  return `Inspect only the fixed target regions in the attached complete bathroom photograph. This is a visible-material observation, not room completion or redesign. IDs identify previously observed regions, not confirmed objects. No previous class or description is supplied. Do not add objects, IDs, positions, or dimensions.
Bounds are normalized [0,1] left/top/right/bottom in the upright image, origin upper-left. Judge the object or surface inside the exact target region. Use surrounding photo context only to interpret it; do not replace the target with a more prominent neighboring fixture. A box may be partial, erroneous, overlap another box, show a reflection, or contain several objects.
For each target FIRST write note describing visible edges, surface behavior, folds or rigidity, attachment evidence, and uncertainty. THEN choose the typed fields. Do not select a material merely because this is a bathroom or because a region is pale, shiny, rectangular, transparent, or beside a shower.
context: physical = the target is directly visible in this room; reflected = the target entity exists only as an image in a mirror; uncertain = direct versus reflected status cannot be established. A directly visible reflective or transparent panel is physical; its reflected or transmitted contents do not make the panel itself a reflected object.
dividerMaterial definitions: fabric-curtain = a flexible hanging sheet used as a divider, supported by visible drape, folds, flexible edges, or attachment evidence; rigid-glass = a rigid transparent/translucent divider panel with supporting panel-edge or structural evidence, not a mirror; solid-wall = an opaque solid partition or low divider wall, not an ordinary room boundary wall or storage cabinet; mixed-or-unclear = multiple divider materials are present in the target or visible evidence cannot reliably distinguish them; not-divider = the target itself is another object or surface, such as a mirror, cabinet, basin, toilet, shelf, ordinary room wall, trim, or an incorrectly boxed region. The region need not be a divider. If it is clearly another object use not-divider. If divider identity or material is unresolved use mixed-or-unclear and explain.
visibleExtent describes the observed target region: whole = the complete visible outer extent of one divider is established; part = only part of a divider is seen or boxed, including image-edge cropping or occlusion; multiple = more than one distinct divider structure lies within the target; unknown = scope cannot be established, including a not-divider target. Do not infer hidden dimensions from whole/part.
support describes an actually visible divider attachment: rod = hanging from a visible bar or rod; track = visible ceiling/wall track; frame = rigid frame supporting the divider; unknown = no support is established, several incompatible supports apply, or the target is not a divider. A nearby towel rail or unrelated window frame is not support evidence. Do not infer an unseen rod or frame from the selected material.
Return one row for every provided ID exactly once, preserving IDs. Two overlapping or identical boxes must still receive separate rows; this contract does not infer or apply duplicate links. Do not issue editing instructions. Return only JSON matching the exact schema.
Fixed targets (ID and observed bounds only):
${JSON.stringify(fixed)}
Exact JSON schema (also supplied unchanged as the structured output constraint):
${JSON.stringify(dividerObservationJsonSchemaFor(fixed))}`;
}
const rowSchema = z.strictObject({
  id: z.string().min(1).max(80),
  note: z
    .string()
    .min(1)
    .max(800)
    .refine((value) => value.trim().length > 0),
  context: z.enum(contexts),
  dividerMaterial: z.enum(materials),
  visibleExtent: z.enum(extents),
  support: z.enum(supports),
});
const responseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observations: z.array(rowSchema).min(1).max(24),
});
export type DividerObservation = z.infer<typeof rowSchema>;
export type DividerObservationWarning = {
  candidateId: string;
  code: 'not-divider-incidental-field-leak' | 'target-not-confirmed-direct';
  fields?: string[];
  action: 'retain-raw-do-not-apply';
};
export type ParsedDividerObservation = {
  contract: typeof DIVIDER_OBSERVATION_CONTRACT;
  promptRevision: typeof DIVIDER_OBSERVATION_PROMPT_REVISION;
  observations: DividerObservation[];
  warnings: DividerObservationWarning[];
  targetsSignature: string;
  automaticApplication: false;
};
/** Preserve model prose and typed values, including contradictory auxiliary fields. */
export function parseDividerObservation(
  raw: string,
  targets: readonly DividerTarget[],
): ParsedDividerObservation {
  const fixed = validateDividerTargets(targets);
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 150_000)
    throw new Error('칸막이 재질 관측 응답 크기를 확인해 주세요.');
  const result = responseSchema.parse(JSON.parse(raw)),
    ids = new Set(fixed.map((t) => t.id)),
    seen = new Set<string>();
  if (result.observations.length !== fixed.length)
    throw new Error('칸막이 재질 관측 ID 수가 원후보와 달라요.');
  const warnings: DividerObservationWarning[] = [];
  for (const value of result.observations) {
    if (!ids.has(value.id) || seen.has(value.id)) throw new Error('칸막이 재질 관측 ID가 원후보와 달라요.');
    seen.add(value.id);
    if (
      value.dividerMaterial === 'not-divider' &&
      (value.visibleExtent !== 'unknown' || value.support !== 'unknown')
    )
      warnings.push({
        candidateId: value.id,
        code: 'not-divider-incidental-field-leak',
        fields: ['visibleExtent', 'support'],
        action: 'retain-raw-do-not-apply',
      });
    if (value.context !== 'physical')
      warnings.push({
        candidateId: value.id,
        code: 'target-not-confirmed-direct',
        action: 'retain-raw-do-not-apply',
      });
  }
  return {
    contract: DIVIDER_OBSERVATION_CONTRACT,
    promptRevision: DIVIDER_OBSERVATION_PROMPT_REVISION,
    observations: result.observations,
    warnings,
    targetsSignature: dividerTargetsSignature(fixed),
    automaticApplication: false,
  };
}
