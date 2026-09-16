import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import type { ParsedFixtureAppearance } from './fixture-appearance-observation';
import type { DividerObservation, DividerTarget } from './divider-observation';
import type { ReconstructionStandardOptions } from './types';
import { validateInstallationInventory } from './installation-observation';

export const DIVIDER_APPLICATION_REVISION = 'observed-cropped-or-whole-curtain-v1' as const;
type AppearanceContext = Pick<ParsedFixtureAppearance, 'decisions' | 'duplicates'>;
export type DividerApplication = {
  revision: typeof DIVIDER_APPLICATION_REVISION;
  understanding: SceneUnderstanding;
  decisions: {
    candidateId: string;
    status: 'applied' | 'held' | 'unchanged';
    original: SceneCandidate;
    effective: SceneCandidate;
    observation: DividerObservation;
    reasons: string[];
  }[];
  modelOptions: Record<string, Pick<ReconstructionStandardOptions, 'curtainHardware' | 'provenance'>>;
};
/** Stable pre-refinement eligibility. Existing labels choose regions, never the material answer. */
export function dividerObservationTargets(
  inventory: SceneUnderstanding,
  appearance?: AppearanceContext,
): DividerTarget[] {
  const checked = validateInstallationInventory(inventory);
  return checked.candidates
    .filter((candidate) => {
      const original = appearance?.decisions.find((d) => d.candidateId === candidate.id)?.original;
      const alias = appearance?.duplicates.some((d) => d.candidateId === candidate.id);
      return (
        !alias &&
        candidate.reflection === 'physical' &&
        [candidate.kind, original?.kind].some((kind) => kind === 'glassPartition' || kind === 'lowPartition')
      );
    })
    .map(({ id, bounds }) => ({ id, bounds: { ...bounds } }));
}
/** Only a reviewed material change is applied; raw candidates and every other answer stay available. */
export function applyDividerObservations(
  inventory: SceneUnderstanding,
  observations: readonly DividerObservation[],
  appearance?: AppearanceContext,
): DividerApplication {
  const original = validateInstallationInventory(inventory);
  const targets = dividerObservationTargets(original, appearance);
  const ids = new Set(targets.map((t) => t.id));
  if (
    observations.length !== ids.size ||
    new Set(observations.map((o) => o.id)).size !== ids.size ||
    observations.some((o) => !ids.has(o.id))
  )
    throw new Error('칸막이 관측 대상 ID가 원후보와 달라요.');
  const result: DividerApplication = {
    revision: DIVIDER_APPLICATION_REVISION,
    understanding: structuredClone(original),
    decisions: [],
    modelOptions: {},
  };
  for (const observation of observations) {
    const candidate = original.candidates.find((c) => c.id === observation.id)!;
    const effective = result.understanding.candidates.find((c) => c.id === observation.id)!;
    const reasons: string[] = [];
    let status: 'applied' | 'held' | 'unchanged' = 'unchanged';
    if (observation.dividerMaterial === 'fabric-curtain') {
      const cropped =
        candidate.bounds.left <= 0.015 ||
        candidate.bounds.top <= 0.015 ||
        candidate.bounds.right >= 0.985 ||
        candidate.bounds.bottom >= 0.985;
      if (observation.context !== 'physical') reasons.push('실물 커튼인지 확인해야 해요.');
      if (Object.values(candidate.provenance ?? {}).includes('user'))
        reasons.push('사용자가 확인한 값은 자동 재관측으로 덮어쓰지 않아요.');
      if (candidate.validation?.issues.length)
        reasons.push('기존 후보의 종류·관계 모순을 먼저 확인해야 해요.');
      if (
        original.relations.some(
          (r) =>
            (r.frontId === candidate.id || r.behindId === candidate.id) &&
            (r.relation === 'reflectionOf' || r.relation === 'partOf' || r.provenance === 'user'),
        )
      )
        reasons.push('기존 반사·부품·사용자 관계와 커튼 판단을 함께 확인해야 해요.');
      if (!(observation.visibleExtent === 'whole' || (observation.visibleExtent === 'part' && cropped)))
        reasons.push(
          '부분 영역을 전체 커튼으로 맞출 수 없어요. 전체 외곽 또는 사진 경계에서 잘린 범위를 확인해 주세요.',
        );
      if (observation.support === 'frame') reasons.push('단단한 프레임과 매달린 천 판단이 모순돼요.');
      if (reasons.length) status = 'held';
      else {
        status = 'applied';
        effective.kind = 'showerCurtain';
        effective.mounting = 'suspended';
        effective.wall = 'unknown';
        effective.basinStyle = 'unknown';
        delete effective.anchor;
        effective.provenance = {
          ...effective.provenance,
          kind: 'model',
          mounting: 'geometry',
          wall: 'default',
          position: 'default',
        };
        effective.uncertainty = [
          ...new Set([
            ...effective.uncertainty,
            '커튼의 전체 규격·걸이 높이·위치는 미확정이며 표준 모형으로 추정해요.',
          ]),
        ].slice(-6);
        result.modelOptions[candidate.id] = {
          curtainHardware: observation.support === 'track' ? 'track' : 'rod',
          provenance: { curtainHardware: observation.support === 'unknown' ? 'default' : 'model' },
        };
        reasons.push(
          '고정 영역의 실물 천 재질 관측으로 커튼 종류를 적용했어요. 설치 방식은 천 재질에서 도출했으며 높이는 측정하지 않았어요.',
        );
        reasons.push(
          observation.support === 'unknown'
            ? '지지 방식을 확정하지 못해 수정 가능한 기본 봉을 사용해요.'
            : '관측한 지지 방식의 표준 모형을 사용해요.',
        );
        if (observation.visibleExtent === 'part')
          reasons.push('사진 경계에서 잘린 외곽은 한쪽 제약으로만 사용하며 숨은 폭·높이는 기본값이에요.');
        const quarantined = result.understanding.relations.filter(
          (r) => r.frontId === candidate.id && r.relation === 'visibleThrough',
        );
        if (quarantined.length) {
          result.understanding.validation ??= {
            rawCandidateCount: original.candidates.length,
            quarantinedRelations: [],
            roomLayoutIssues: [],
          };
          result.understanding.validation.quarantinedRelations.push(
            ...quarantined.map((relation) => ({
              relation: structuredClone(relation),
              issues: [
                {
                  code: 'opaque-curtain-relation',
                  message: '불투명 커튼과 기존 투과 관계가 모순되어 관계만 보류했어요.',
                },
              ],
            })),
          );
          result.understanding.relations = result.understanding.relations.filter(
            (r) => !quarantined.includes(r),
          );
        }
      }
    } else
      reasons.push(
        '유리·벽·기타 재질 답변은 자동 종류 변경으로 검증되지 않아 기존 결과를 유지하고 재관측 원문을 보존했어요.',
      );
    result.decisions.push({
      candidateId: candidate.id,
      status,
      original: structuredClone(candidate),
      effective: structuredClone(effective),
      observation: structuredClone(observation),
      reasons,
    });
  }
  validateInstallationInventory(result.understanding);
  return result;
}
