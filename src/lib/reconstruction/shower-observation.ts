import { z } from 'zod';
import type { SceneUnderstanding } from './pipeline-contract';
import { layoutInventorySignature } from './layout-observation';

export const SHOWER_OBSERVATION_CONTRACT = 'fixed-shower-detail-v1' as const;
export const SHOWER_OBSERVATION_PROMPT_REVISION = 1;
const row = z.strictObject({
  id: z.string().min(1).max(80),
  note: z.string().trim().min(12).max(800),
  kind: z.enum(['shower', 'tap-only', 'not-fixture', 'unknown']),
  context: z.enum(['physical', 'reflected', 'uncertain']),
  style: z.enum(['hand-spray', 'handheld-rail', 'overhead-set', 'unknown']),
  observedPart: z.enum(['whole-kit', 'handset', 'overhead-head', 'control', 'mixed', 'unknown']),
  visibleParts: z.strictObject({
    handheldHead: z.enum(['present', 'absent', 'uncertain']),
    overheadHead: z.enum(['present', 'absent', 'uncertain']),
    verticalRail: z.enum(['present', 'absent', 'uncertain']),
    hose: z.enum(['present', 'absent', 'uncertain']),
  }),
});
export const showerObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observations: z.array(row).max(24),
});
export type ShowerObservation = z.infer<typeof row>;
export type ParsedShowerObservation = {
  inventorySignature: string;
  observations: ShowerObservation[];
};
export function showerObservationTargets(inventory: SceneUnderstanding) {
  return inventory.candidates.filter(
    (candidate) =>
      candidate.kind === 'shower' &&
      candidate.reflection === 'physical' &&
      !inventory.relations.some(
        (relation) =>
          relation.relation === 'reflectionOf' &&
          (relation.frontId === candidate.id || relation.behindId === candidate.id),
      ) &&
      !candidate.validation?.issues.length &&
      !Object.values(candidate.provenance ?? {}).includes('user'),
  );
}
export function showerObservationJsonSchemaFor(inventory: SceneUnderstanding) {
  const ids = showerObservationTargets(inventory).map((candidate) => candidate.id);
  if (!ids.length || ids.length > 24 || new Set(ids).size !== ids.length)
    throw new Error('샤워 세부 관측에 사용할 고유 설비 ID가 필요해요.');
  const result = z.toJSONSchema(showerObservationSchema);
  const observations = result.properties!.observations;
  if (
    typeof observations !== 'object' ||
    !observations.items ||
    typeof observations.items !== 'object' ||
    Array.isArray(observations.items) ||
    !observations.items.properties
  )
    throw new Error('샤워 관측 schema 구조가 올바르지 않아요.');
  observations.items.properties.id = { type: 'string', enum: ids };
  observations.minItems = ids.length;
  observations.maxItems = ids.length;
  return result;
}
export function showerObservationPrompt(inventory: SceneUnderstanding) {
  const targets = showerObservationTargets(inventory).map(({ id, bounds }) => ({ id, bounds }));
  return `Inspect only the fixed target regions in this bathroom photo. They are regions, not confirmed shower kits. Do not add objects or infer hidden components. Coordinates are normalized 0..1 in the upright full photo.
First describe visible hardware in note, then answer the typed fields. Use the full photo for context but observedPart describes what the target box actually encloses. A small head box is not a whole kit even when its hose continues outside it. mixed means the box encloses multiple separate fixtures. A reflection is an image of the target in a mirror, not a shiny metal surface.
kind: shower = visible shower/spray hardware; tap-only = a visible faucet or mixer with no shower head or shower assembly established; not-fixture = background/clutter; unknown = insufficient evidence. Do not call a wall faucet an overhead shower.
style: hand-spray = compact hand spray with holder, no tall shower rail or overhead head established; handheld-rail = handheld shower visibly supported on a vertical rail; overhead-set = fixed overhead shower head and its supporting arm or pipe; unknown = style not established. A hose alone does not establish any style. Do not choose a style from the adjacent toilet, location, or apparent size alone.
observedPart: whole-kit = the box covers the visible assembly as a unit; handset = it specifically encloses the handheld/spray head and its holder, not the rest of the hose or rail; overhead-head = fixed shower head/arm only, not full-height plumbing; control = faucet/mixer controls only; mixed or unknown when necessary. The observed box is never a measured physical size.
visibleParts records evidence in the target and its visibly connected assembly. Do not attribute unrelated plumbing behind glass or inside mirrors. present needs visible evidence, absent needs evidence of absence, otherwise uncertain. For non-shower kinds use style=unknown.
Targets (IDs and regions only; no previous classification or notes): ${JSON.stringify(targets)}
Return only JSON matching this exact schema: ${JSON.stringify(showerObservationJsonSchemaFor(inventory))}`;
}
export function parseShowerObservation(raw: string, inventory: SceneUnderstanding): ParsedShowerObservation {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 150_000)
    throw new Error('샤워 세부 관측 응답 크기를 확인해 주세요.');
  const result = showerObservationSchema.parse(JSON.parse(raw));
  const ids = showerObservationTargets(inventory).map((candidate) => candidate.id);
  if (
    result.observations.length !== ids.length ||
    new Set(result.observations.map((value) => value.id)).size !== ids.length ||
    result.observations.some((value) => !ids.includes(value.id))
  )
    throw new Error('샤워 세부 관측 ID가 원후보와 달라요.');
  for (const value of result.observations) {
    if (value.kind !== 'shower' && value.style !== 'unknown')
      throw new Error('샤워 외 대상에 샤워 종류가 들어 있어요.');
  }
  return { observations: result.observations, inventorySignature: layoutInventorySignature(inventory) };
}

/** Contradictory evidence stays reviewable; prose never selects a model variant. */
export function showerObservationDecision(value: ShowerObservation) {
  const reasons: string[] = [];
  if (value.context !== 'physical') reasons.push('샤워 설비의 실물 여부를 확인해야 해요.');
  if (value.kind !== 'shower') reasons.push('완전한 샤워 설비로 확인되지 않았어요.');
  if (value.style === 'unknown') reasons.push('샤워의 세부 종류를 확인해야 해요.');
  if (['control', 'mixed', 'unknown'].includes(value.observedPart))
    reasons.push('관측 영역과 샤워 모형의 대응 부위를 확인해야 해요.');
  if (
    value.style === 'hand-spray' &&
    (value.visibleParts.handheldHead !== 'present' ||
      value.visibleParts.verticalRail === 'present' ||
      value.visibleParts.overheadHead === 'present' ||
      !['whole-kit', 'handset'].includes(value.observedPart))
  )
    reasons.push('작은 위생 샤워의 관측 근거가 모순돼요.');
  if (
    value.style === 'handheld-rail' &&
    (value.visibleParts.handheldHead !== 'present' ||
      value.visibleParts.verticalRail !== 'present' ||
      value.visibleParts.overheadHead === 'present' ||
      !['whole-kit', 'handset'].includes(value.observedPart))
  )
    reasons.push('레일형 샤워의 헤드·레일 근거를 확인해야 해요.');
  if (
    value.style === 'overhead-set' &&
    (value.visibleParts.overheadHead !== 'present' ||
      !['whole-kit', 'overhead-head'].includes(value.observedPart))
  )
    reasons.push('상부 샤워 헤드와 관측 범위의 대응을 확인해야 해요.');
  return { applicable: reasons.length === 0, reasons };
}

export const SHOWER_DETAIL_ADOPTION_REVISION = 'observed-shower-composition-v2' as const;
/** Only the independently reviewed subcases are adopted. Other model classifications remain evidence. */
export function adoptedShowerObservationDecision(value: ShowerObservation): {
  action: 'apply' | 'hold' | 'unchanged';
  reasons: string[];
} {
  const checked = showerObservationDecision(value);
  if (value.style === 'hand-spray' && value.observedPart === 'handset' && checked.applicable)
    return {
      action: 'apply',
      reasons: ['관측한 소형 헤드와 해당 모형 부위를 대응하는 검증된 경로를 사용해요.'],
    };
  if (
    value.kind === 'tap-only' &&
    value.context === 'physical' &&
    value.style === 'unknown' &&
    value.observedPart === 'control'
  )
    return {
      action: 'hold',
      reasons: ['수전 부위만 확인되어 큰 샤워 세트로 생성하지 않았어요. 원후보와 세부 관측은 보존했어요.'],
    };
  return {
    action: 'unchanged',
    reasons: ['이 세부 관측 조합은 자동 변경 품질이 검증되지 않아 기존 배치 경로를 유지했어요.'],
  };
}
