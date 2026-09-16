import { z } from 'zod';
import { candidateBoxIoU } from './candidate-resolution';
import { layoutInventorySignature } from './layout-observation';
import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import type { ReconstructionStandardOptions } from './types';
import type { LocalSceneAnalysis } from './analysis-client';

/** The v1 prompt/schema are retained exactly from the recorded four-photo experiment. */
export const FIXTURE_APPEARANCE_CONTRACT = 'fixed-candidate-appearance-v1' as const;
export const FIXTURE_APPEARANCE_PROMPT_REVISION = 1;
export const FIXTURE_APPEARANCE_RULE_REVISION = 'appearance-decision-v3';
export const fixtureAppearanceKinds = [
  'wall_basin',
  'pedestal_basin',
  'enclosed_vanity',
  'open_counter_basin',
  'mirror',
  'mirror_cabinet',
  'wall_cabinet',
  'glass_partition',
  'opaque_low_partition',
  'shower',
  'wall_shelf',
  'door',
  'door_frame_only',
  'window',
  'toilet',
  'bathtub',
  'unknown',
] as const;
const rowSchema = z.strictObject({
  id: z.string().min(1).max(80),
  note: z.string().trim().min(12).max(800),
  kind: z.enum(fixtureAppearanceKinds),
  context: z.enum(['physical', 'reflected', 'uncertain', 'not-fixture']),
  sameObjectAs: z.string().min(1).max(80).nullable(),
  shape: z.enum(['rectangular', 'oval', 'arched', 'unknown']),
  counterSupport: z.enum(['wall', 'left-panel', 'right-panel', 'both-panels', 'unknown']),
  // Omission must remain omission when re-reading historical local/Qwen analyses.
  pedestalShape: z.enum(['round', 'rectangular', 'unknown']).optional(),
});
export const fixtureAppearanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observations: z.array(rowSchema).max(24),
});
export type FixtureAppearanceObservation = z.infer<typeof rowSchema>;
export type FixtureAppearanceOptions = Pick<
  ReconstructionStandardOptions,
  'mirrorShape' | 'vanityStyle' | 'counterSupport' | 'showerVariant' | 'pedestalShape' | 'provenance'
>;
export type FixtureAppearanceDecision = {
  candidateId: string;
  status: 'applied' | 'confirmed' | 'held' | 'duplicate';
  original: SceneCandidate;
  effective: SceneCandidate;
  observation: FixtureAppearanceObservation;
  reasons: string[];
};
export type ParsedFixtureAppearance = {
  observations: FixtureAppearanceObservation[];
  inventorySignature: string;
  ruleRevision: typeof FIXTURE_APPEARANCE_RULE_REVISION;
  understanding: SceneUnderstanding;
  decisions: FixtureAppearanceDecision[];
  modelOptions: Record<string, FixtureAppearanceOptions>;
  duplicates: { candidateId: string; canonicalId: string; reason: string }[];
};

// Explicit hand-built schema keeps the proven prompt/schema byte semantics independent of Zod versions.
export function fixtureAppearanceJsonSchemaFor(inventory: SceneUnderstanding) {
  const ids = inventory.candidates.map((c) => c.id);
  if (!ids.length || ids.length > 24 || new Set(ids).size !== ids.length)
    throw new Error('형태 재확인에 사용할 고유 설비 ID가 필요해요.');
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 1 },
      observations: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', enum: ids },
            note: { type: 'string', minLength: 12, maxLength: 800 },
            kind: { type: 'string', enum: [...fixtureAppearanceKinds] },
            context: { type: 'string', enum: ['physical', 'reflected', 'uncertain', 'not-fixture'] },
            sameObjectAs: { anyOf: [{ type: 'null' }, { type: 'string', enum: ids }] },
            shape: { type: 'string', enum: ['rectangular', 'oval', 'arched', 'unknown'] },
            counterSupport: {
              type: 'string',
              enum: ['wall', 'left-panel', 'right-panel', 'both-panels', 'unknown'],
            },
          },
          required: ['id', 'note', 'kind', 'context', 'sameObjectAs', 'shape', 'counterSupport'],
        },
      },
    },
    required: ['schemaVersion', 'observations'],
  };
}

export function fixtureAppearancePrompt(inventory: SceneUnderstanding) {
  const evidence = inventory.candidates.map((c) => ({ id: c.id, bounds: { ...c.bounds } }));
  return `Examine the attached bathroom photograph and re-identify ONLY the existing boxed candidates below. This is an observation experiment, not a request to redesign or complete the room.
Return strict JSON matching the supplied schema, one observation per provided ID. Do not add IDs, new objects, positions or dimensions. A box may be incomplete, mistaken, overlap another box, or describe a reflection. Use the entire photo to interpret the object inside the box, but do not search for unlisted objects. Bounds are normalized [0,1] left/top/right/bottom with origin at the upper-left of the upright image.
For each ID, FIRST write a concise note of visible structural evidence and uncertainties, THEN choose kind and remaining fields. Do not infer a cabinet solely from a rectangular front, or glass solely from a reflective surface.
kind definitions: wall_basin = basin hanging from wall with no full floor pedestal and no enclosing cabinet; pedestal_basin = basin supported by a narrow pedestal reaching the floor; enclosed_vanity = storage base with visible enclosing cabinet body/doors under basin/counter; open_counter_basin = basin and counter with visibly open space below rather than cabinet doors; mirror = reflective panel; mirror_cabinet = mirror-front storage box with visible body depth, cabinet edges/doors or other storage evidence; wall_cabinet = opaque-front wall storage cabinet; glass_partition = separate transparent/translucent shower divider; opaque_low_partition = solid low wall/divider; shower = showerhead/hose/control fixture; wall_shelf = wall shelf or towel rack; door = visible door leaf; door_frame_only = frame/jamb without an actual visible leaf; window/toilet/bathtub = those fixtures; unknown = insufficient evidence for the listed kinds.
context: physical means directly visible actual fixture; reflected means only an image of an object in a mirror; uncertain means direct/reflected status cannot be established; not-fixture means the box is merely wall, light/shadow, trim, incidental clutter or another non-target area.
sameObjectAs must be null unless two boxes clearly refer to the SAME physical object, including a reflected view of that same object. For duplicates, point the later listed ID to the earlier listed ID. A separate basin resting on a separate counter/cabinet, a glass panel on a low wall, a shelf next to a mirror, or cabinet next to a mirror are related parts/objects, not automatically duplicate objects. Do not join items just because their boxes overlap.
shape describes the dominant visible basin bowl outline or mirror/panel outer outline: rectangular/oval/arched/unknown. Do not invent hidden outlines. counterSupport applies only to open_counter_basin: wall/left-panel/right-panel/both-panels/unknown based on visible support. Use unknown for every other kind. Left/right support are as seen in this photograph.
Never claim certainty from an unseen cabinet interior or backside. If evidence is insufficient use unknown/uncertain and explain in note. Do not trust any prior detector class: none is supplied.
Provided candidates (ID and observed bounds only):
${JSON.stringify(evidence)}`;
}

const kinds: Record<FixtureAppearanceObservation['kind'], SceneCandidate['kind']> = {
  wall_basin: 'basin',
  pedestal_basin: 'basin',
  enclosed_vanity: 'vanity',
  open_counter_basin: 'vanity',
  mirror: 'mirror',
  mirror_cabinet: 'mirrorCabinet',
  wall_cabinet: 'wallCabinet',
  glass_partition: 'glassPartition',
  opaque_low_partition: 'lowPartition',
  shower: 'shower',
  wall_shelf: 'wallShelf',
  door: 'door',
  door_frame_only: 'unknown',
  window: 'window',
  toilet: 'toilet',
  bathtub: 'bath',
  unknown: 'unknown',
};
const wallKinds = [
  'wall_basin',
  'mirror',
  'mirror_cabinet',
  'wall_cabinet',
  'shower',
  'wall_shelf',
  'window',
  'door',
];
const floorKinds = ['pedestal_basin', 'toilet', 'bathtub', 'opaque_low_partition', 'glass_partition'];

/** Re-identification never adds/removes candidates, invents coordinates, or executes model prose. */
export function parseFixtureAppearance(
  rawText: string,
  inventory: SceneUnderstanding,
): ParsedFixtureAppearance {
  if (typeof rawText !== 'string' || new TextEncoder().encode(rawText).length > 150_000)
    throw new Error('형태 재확인 응답 크기를 확인해 주세요.');
  const parsed = fixtureAppearanceSchema.parse(JSON.parse(rawText));
  const original = new Map(inventory.candidates.map((c) => [c.id, c]));
  const rows = new Map(parsed.observations.map((r) => [r.id, r]));
  if (
    original.size !== inventory.candidates.length ||
    rows.size !== parsed.observations.length ||
    rows.size !== original.size ||
    [...rows.keys()].some((id) => !original.has(id))
  )
    throw new Error('형태 재확인의 설비 ID가 기존 관측과 달라요.');
  for (const r of rows.values()) {
    if (r.kind !== 'open_counter_basin' && r.counterSupport !== 'unknown')
      throw new Error('상판 외 설비에 상판 지지 정보가 들어 있어요.');
    if (r.kind !== 'pedestal_basin' && r.pedestalShape !== undefined && r.pedestalShape !== 'unknown')
      throw new Error('기둥 세면대 외 설비에 기둥 단면 정보가 들어 있어요.');
    const seen = new Set([r.id]);
    let current = r;
    while (current.sameObjectAs !== null) {
      if (!rows.has(current.sameObjectAs) || seen.has(current.sameObjectAs))
        throw new Error('동일 설비 참조가 없거나 순환해요.');
      seen.add(current.sameObjectAs);
      current = rows.get(current.sameObjectAs)!;
    }
  }
  const result: ParsedFixtureAppearance = {
    observations: parsed.observations,
    inventorySignature: layoutInventorySignature(inventory),
    ruleRevision: FIXTURE_APPEARANCE_RULE_REVISION,
    understanding: structuredClone(inventory),
    decisions: [],
    modelOptions: {},
    duplicates: [],
  };
  for (const candidate of result.understanding.candidates) {
    const row = rows.get(candidate.id)!;
    const decision: FixtureAppearanceDecision = {
      candidateId: candidate.id,
      status: 'confirmed',
      original: structuredClone(candidate),
      effective: candidate,
      observation: row,
      reasons: [],
    };
    result.decisions.push(decision);
    if (Object.values(candidate.provenance ?? {}).includes('user')) {
      decision.status = 'held';
      decision.reasons.push('사용자 확인값은 자동 관측으로 변경하지 않았어요.');
      continue;
    }
    if (candidate.validation?.issues.length) {
      decision.status = 'held';
      decision.reasons.push('기존 관측의 검증 오류를 형태 관측으로 지우지 않았어요.');
      continue;
    }
    const appendSummary = (items: string[], text: string) => [
      ...new Set([...items.slice(0, 5), text.slice(0, 240).trim()]),
    ];
    candidate.evidence = appendSummary(candidate.evidence, row.note);
    if (row.note.length > 240 || decision.original.evidence.length >= 6)
      decision.reasons.push(
        '후속 장면 관측의 근거는 최대 6개·각 240자로 제한했어요. 전체 관측 문장과 이전 근거는 원문·교정 기록에 보존했어요.',
      );
    if (row.kind === 'unknown' && row.context === 'physical') {
      // A real object was seen, but the new structural classification no longer supports the old kind.
      // Keep its ID/box/original in the ledger rather than render an unsupported old cabinet/fixture.
      candidate.kind = 'unknown';
      candidate.basinStyle = 'unknown';
      delete candidate.bowlCount;
      candidate.provenance = { ...candidate.provenance, kind: 'model' };
      candidate.uncertainty = appendSummary(
        candidate.uncertainty,
        '실물 영역은 확인했지만 표준 설비 종류를 확정하지 못했어요. 이전 종류로 임의 생성하지 않아요.',
      );
      decision.status = 'held';
      decision.reasons.push(candidate.uncertainty.at(-1)!);
      continue;
    }
    if (row.context === 'uncertain' || row.kind === 'unknown') {
      if (row.context !== 'not-fixture') {
        decision.status = 'held';
        decision.reasons.push('새 관측만으로 종류·실물 여부를 확정하지 못해 원값을 보존했어요.');
        candidate.uncertainty = appendSummary(candidate.uncertainty, '형태 재확인 보류: ' + row.note);
        continue;
      }
    }
    if (row.context === 'reflected') {
      candidate.reflection = 'reflected';
      decision.reasons.push('별도 사진 관측에서 거울 속 반사로 분류했어요. 원후보는 보존해요.');
    } else if (row.context === 'physical' && candidate.reflection === 'reflected') {
      decision.status = 'held';
      decision.reasons.push('기존 반사 판정과 충돌해 자동 실물 승격을 보류했어요.');
      continue;
    }
    if (row.context === 'not-fixture' || row.kind === 'door_frame_only') {
      candidate.kind = 'unknown';
      candidate.uncertainty = appendSummary(
        candidate.uncertainty,
        row.kind === 'door_frame_only'
          ? '문틀만 보이고 문짝이 확인되지 않아 완전한 문 모형을 생성하지 않았어요.'
          : '별도 관측에서 설비가 아닌 영역으로 분류했어요. 목록과 원영역은 보존해요.',
      );
    } else {
      candidate.kind = kinds[row.kind];
      if (wallKinds.includes(row.kind)) candidate.mounting = 'wall';
      if (floorKinds.includes(row.kind)) candidate.mounting = 'floor';
      candidate.basinStyle =
        row.kind === 'wall_basin' ? 'wall' : row.kind === 'pedestal_basin' ? 'pedestal' : 'unknown';
      if (row.shape === 'rectangular' || row.shape === 'oval') {
        candidate.shape = row.shape === 'oval' ? 'round' : 'rectangular';
        candidate.provenance = { ...candidate.provenance, shape: 'model' };
      }
      if (
        row.kind === 'pedestal_basin' &&
        row.context === 'physical' &&
        row.pedestalShape !== undefined &&
        row.pedestalShape !== 'unknown'
      )
        result.modelOptions[candidate.id] = {
          pedestalShape: row.pedestalShape,
          provenance: { pedestalShape: 'model' },
        };
      if (row.kind === 'mirror' && row.shape !== 'unknown')
        result.modelOptions[candidate.id] = { mirrorShape: row.shape, provenance: { mirrorShape: 'model' } };
      if (row.kind === 'open_counter_basin') {
        // Photo-left/right panels cannot be silently converted to product-local left/right after yaw.
        const support = row.counterSupport === 'both-panels' ? 'both-panels' : 'wall';
        candidate.mounting = support === 'wall' ? 'wall' : 'floor';
        result.modelOptions[candidate.id] = {
          vanityStyle: 'open-counter',
          counterSupport: support,
          provenance: {
            vanityStyle: 'model',
            counterSupport: row.counterSupport === support ? 'model' : 'default',
          },
        };
        if (row.counterSupport !== support)
          decision.reasons.push(
            '지지판의 방향·존재가 미확정이라 벽 지지 기본 모형을 사용해요. 실측·관측값이 아니에요.',
          );
      } else if (row.kind === 'enclosed_vanity')
        result.modelOptions[candidate.id] = { vanityStyle: 'enclosed', provenance: { vanityStyle: 'model' } };
    }
    if (!['basin', 'vanity'].includes(candidate.kind)) delete candidate.bowlCount;
    if (candidate.kind !== 'basin') candidate.basinStyle = 'unknown';
    if (candidate.kind !== decision.original.kind)
      candidate.provenance = { ...candidate.provenance, kind: 'model' };
    if (candidate.mounting !== decision.original.mounting) {
      candidate.provenance = {
        ...candidate.provenance,
        mounting: row.kind === 'open_counter_basin' && row.counterSupport === 'unknown' ? 'default' : 'model',
      };
      // Original contact remains in decision.original; a contact for another installation is not reused.
      delete candidate.anchor;
    }
    decision.status =
      JSON.stringify(decision.original) === JSON.stringify(candidate) ? 'confirmed' : 'applied';
  }
  // Explicit same-object evidence is additional to overlap and compatible physical classifications.
  for (const row of rows.values()) {
    if (!row.sameObjectAs) continue;
    const decision = result.decisions.find((d) => d.candidateId === row.id)!;
    const targetDecision = result.decisions.find((d) => d.candidateId === row.sameObjectAs)!;
    const a = decision.effective,
      b = targetDecision.effective;
    if (
      decision.status === 'held' ||
      targetDecision.status === 'held' ||
      row.context !== 'physical' ||
      rows.get(b.id)?.context !== 'physical' ||
      a.kind === 'unknown' ||
      a.kind !== b.kind ||
      candidateBoxIoU(a.bounds, b.bounds) < 0.8 ||
      result.understanding.candidates.findIndex((c) => c.id === b.id) >=
        result.understanding.candidates.findIndex((c) => c.id === a.id)
    ) {
      decision.reasons.push('동일 설비 제안은 실물·종류·영역·참조 순서 검사에 맞지 않아 적용하지 않았어요.');
      continue;
    }
    const canonicalId = result.duplicates.find((d) => d.candidateId === b.id)?.canonicalId ?? b.id;
    const reason = '별도 AI가 같은 실물로 관측했고 호환 종류·80% 이상 영역 겹침을 확인했어요. ' + row.note;
    result.duplicates.push({ candidateId: a.id, canonicalId, reason });
    decision.status = 'duplicate';
    decision.reasons.push(reason);
  }
  return result;
}

export type LocalFixtureAppearanceAnalysis = Omit<LocalSceneAnalysis, 'outputContract' | 'understanding'> &
  ParsedFixtureAppearance & { outputContract: typeof FIXTURE_APPEARANCE_CONTRACT; photoFingerprint: string };
