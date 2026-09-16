import type { FixtureAppearanceDecision } from './fixture-appearance-observation';
import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';

export const CAMERA_RANKING_REVISION = 'kind-conflict-image-hold-v1' as const;
export type CameraRankingSolution = {
  id: string;
  fullScore: number;
  imageContributions: { candidateId: string; image: number }[];
};
export type CameraRankingInput = {
  candidates: readonly SceneCandidate[];
  decisions: readonly FixtureAppearanceDecision[];
  relations: SceneUnderstanding['relations'];
  manualIds?: ReadonlySet<string>;
  /** Verified assemblies/aliases lack independent whole-object bounds in this contract. */
  excludedAnchorIds?: ReadonlySet<string>;
  solutions: readonly CameraRankingSolution[];
};
export type CameraRankingAssessment = {
  revision: typeof CAMERA_RANKING_REVISION;
  status: 'applied' | 'no-conflicts' | 'insufficient' | 'unstable' | 'invalid';
  reason: string;
  fullScoreWinner?: string;
  proposedWinner?: string;
  selectedWinner?: string;
  conflicts: {
    candidateId: string;
    originalKind: SceneCandidate['kind'];
    effectiveKind: SceneCandidate['kind'];
  }[];
  /** Agreement is not an independent measurement or a calibrated confidence. */
  agreementGroups: { candidateIds: string[]; centre: [number, number] }[];
  rows: { id: string; fullScore: number; withheldImage: number; rankingScore: number }[];
  leaveOneGroupOut: { candidateIds: string[]; winner?: string; tied: boolean; margin: number }[];
};
const tolerance = 1e-9;

/** Re-ranks already solved, physically checked scenes. Never edits candidates, plans, or full scores. */
export function assessCameraRanking(input: CameraRankingInput): CameraRankingAssessment {
  const full = [...input.solutions].sort((a, b) => a.fullScore - b.fullScore);
  const result: CameraRankingAssessment = {
    revision: CAMERA_RANKING_REVISION,
    status: 'insufficient',
    reason: '카메라 비교 근거가 충분하지 않아 기존 장면 점수를 유지해요.',
    fullScoreWinner: full[0]?.id,
    selectedWinner: full[0]?.id,
    conflicts: [],
    agreementGroups: [],
    rows: [],
    leaveOneGroupOut: [],
  };
  const candidateMap = new Map(input.candidates.map((item) => [item.id, item]));
  const validSolutions = full.every(
    (row) =>
      Number.isFinite(row.fullScore) &&
      row.fullScore >= 0 &&
      new Set(row.imageContributions.map((item) => item.candidateId)).size ===
        row.imageContributions.length &&
      row.imageContributions.every(
        (item) => candidateMap.has(item.candidateId) && Number.isFinite(item.image) && item.image >= 0,
      ) &&
      row.imageContributions.reduce((sum, item) => sum + item.image, 0) <= row.fullScore + tolerance,
  );
  if (
    !validSolutions ||
    candidateMap.size !== input.candidates.length ||
    new Set(full.map((row) => row.id)).size !== full.length ||
    new Set(input.decisions.map((row) => row.candidateId)).size !== input.decisions.length
  ) {
    result.status = 'invalid';
    result.reason = '카메라 기여값 또는 연결 ID가 유효하지 않아 기존 점수를 유지해요.';
    return result;
  }
  const agreementIds = new Set<string>();
  for (const decision of input.decisions) {
    const item = candidateMap.get(decision.candidateId);
    if (!item || item.id !== decision.original.id || item.id !== decision.effective.id) {
      result.status = 'invalid';
      result.reason = '형태 관측의 연결 ID가 현재 후보와 맞지 않아 기존 카메라를 유지해요.';
      return result;
    }
    if (
      item.kind !== decision.effective.kind ||
      input.manualIds?.has(item.id) ||
      item.provenance?.kind === 'user' ||
      decision.effective.provenance?.kind === 'user' ||
      (decision.status !== 'applied' && decision.status !== 'confirmed') ||
      decision.original.kind === 'unknown' ||
      decision.effective.kind === 'unknown'
    )
      continue;
    if (decision.original.kind !== decision.effective.kind) {
      result.conflicts.push({
        candidateId: item.id,
        originalKind: decision.original.kind,
        effectiveKind: decision.effective.kind,
      });
    } else if (
      !input.excludedAnchorIds?.has(item.id) &&
      item.reflection === 'physical' &&
      decision.original.reflection === 'physical' &&
      full.every((row) => row.imageContributions.some((part) => part.candidateId === item.id))
    )
      agreementIds.add(item.id);
  }
  result.conflicts.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const conflicts = new Set(result.conflicts.map((item) => item.candidateId));
  result.rows = full.map((row) => {
    const withheldImage = row.imageContributions.reduce(
      (sum, part) => sum + (conflicts.has(part.candidateId) ? part.image : 0),
      0,
    );
    return {
      id: row.id,
      fullScore: row.fullScore,
      withheldImage,
      rankingScore: row.fullScore - withheldImage,
    };
  });
  if (!result.rows.some((row) => row.withheldImage > tolerance)) {
    result.status = 'no-conflicts';
    result.reason = '배치된 후보의 알려진 종류 충돌 기여가 없어 기존 카메라를 유지해요.';
    return result;
  }
  if (full.length < 2) return result;
  // Existing typed partOf links define correlated groups. Never infer links from overlap or notes.
  const neighbours = new Map(input.candidates.map((item) => [item.id, new Set<string>()]));
  for (const relation of input.relations) {
    if (
      relation.relation !== 'partOf' ||
      !neighbours.has(relation.frontId) ||
      !neighbours.has(relation.behindId)
    )
      continue;
    neighbours.get(relation.frontId)!.add(relation.behindId);
    neighbours.get(relation.behindId)!.add(relation.frontId);
  }
  const visited = new Set<string>();
  for (const id of [...agreementIds].sort()) {
    if (visited.has(id)) continue;
    const group = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (group.has(current)) continue;
      group.add(current);
      visited.add(current);
      pending.push(...neighbours.get(current)!);
    }
    // A mixed/conflicting assembly is not an independent agreement anchor.
    if (![...group].every((entry) => agreementIds.has(entry))) continue;
    const items = [...group].sort().map((entry) => candidateMap.get(entry)!);
    if (
      items.some(
        ({ bounds: b }) =>
          ![b.left, b.top, b.right, b.bottom].every(Number.isFinite) ||
          b.left < 0 ||
          b.top < 0 ||
          b.right > 1 ||
          b.bottom > 1 ||
          b.right <= b.left ||
          b.bottom <= b.top,
      )
    )
      continue;
    result.agreementGroups.push({
      candidateIds: items.map((item) => item.id),
      centre: [
        items.reduce((sum, item) => sum + (item.bounds.left + item.bounds.right) / 2, 0) / items.length,
        items.reduce((sum, item) => sum + (item.bounds.top + item.bounds.bottom) / 2, 0) / items.length,
      ],
    });
  }
  const centres = result.agreementGroups.map((group) => group.centre);
  // Three non-collinear groups are a conservative stability guard, not proof of camera calibration.
  let spansPlane = false;
  for (let a = 0; a < centres.length; a++)
    for (let b = a + 1; b < centres.length; b++)
      for (let c = b + 1; c < centres.length; c++) {
        const area =
          (centres[b][0] - centres[a][0]) * (centres[c][1] - centres[a][1]) -
          (centres[b][1] - centres[a][1]) * (centres[c][0] - centres[a][0]);
        if (Math.abs(area) > tolerance) spansPlane = true;
      }
  if (!spansPlane) {
    result.reason = '같은 종류로 확인된 서로 다른 세 영역의 화면 분포가 부족해 기존 카메라를 유지해요.';
    return result;
  }
  const ranking = (rows: { id: string; score: number }[]) => {
    const sorted = [...rows].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    const margin = sorted.length > 1 ? sorted[1].score - sorted[0].score : 0;
    return { winner: sorted[0]?.id, tied: margin <= tolerance, margin };
  };
  const proposal = ranking(result.rows.map((row) => ({ id: row.id, score: row.rankingScore })));
  result.proposedWinner = proposal.winner;
  for (const group of result.agreementGroups) {
    const ids = new Set(group.candidateIds);
    const check = ranking(
      result.rows.map((row) => ({
        id: row.id,
        score:
          row.rankingScore -
          full
            .find((solution) => solution.id === row.id)!
            .imageContributions.reduce((sum, part) => sum + (ids.has(part.candidateId) ? part.image : 0), 0),
      })),
    );
    result.leaveOneGroupOut.push({ candidateIds: [...group.candidateIds], ...check });
  }
  if (
    proposal.tied ||
    result.leaveOneGroupOut.some((check) => check.tied || check.winner !== proposal.winner)
  ) {
    result.status = 'unstable';
    result.reason = '다른 설비 한 그룹의 사진 적합도만 빼도 카메라 순위가 바뀌어 기존 카메라를 유지해요.';
    return result;
  }
  result.status = 'applied';
  result.selectedWinner = proposal.winner;
  result.reason =
    '종류 판단이 충돌한 후보의 사진 적합도만 카메라 비교에서 보류했어요. 물리 검사와 배치 점수는 유지하며 실측 카메라를 뜻하지 않아요.';
  return result;
}
