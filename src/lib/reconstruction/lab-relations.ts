import type { SceneCandidate, SceneRelation, SceneUnderstanding } from './pipeline-contract';

export type LabRelationEdits = {
  disconnectedRelations?: string[];
  /** Undefined preserves observed links; null explicitly removes this bowl's parent. */
  supportParents?: Record<string, string | null>;
};
export type LabRelationIssue = { candidateId: string; code: string; message: string };
export const labRelationKey = (relation: SceneRelation) =>
  [relation.frontId, relation.relation, relation.behindId].join(':');

export function collectLabRelations(scene: SceneUnderstanding): SceneRelation[] {
  const unique = new Map<string, SceneRelation>();
  for (const relation of [
    ...scene.relations,
    ...(scene.validation?.quarantinedRelations ?? []).map((item) => item.relation),
  ])
    if (!unique.has(labRelationKey(relation))) unique.set(labRelationKey(relation), relation);
  return [...unique.values()];
}

function disconnectedBounds(child: SceneCandidate, parent: SceneCandidate) {
  const a = child.bounds,
    b = parent.bounds;
  const gapX = Math.max(0, a.left - b.right, b.left - a.right);
  const gapY = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return (
    gapX > Math.max(0.02, (b.right - b.left) * 0.15) ||
    gapY > Math.max(0.02, Math.min(b.bottom - b.top, a.bottom - a.top) * 0.3)
  );
}
function reaches(edges: SceneRelation[], from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return edges.some(
    (edge) => edge.relation === 'partOf' && edge.frontId === from && reaches(edges, edge.behindId, to, seen),
  );
}

/** A relationship edit is user confirmation, never a new model observation or floor contact. */
export function previewLabRelationEdits(scene: SceneUnderstanding, edits: LabRelationEdits) {
  const result = structuredClone(scene);
  const removed = new Set(edits.disconnectedRelations ?? []);
  const parents = edits.supportParents ?? {};
  const ownsParent = (id: string) => Object.prototype.hasOwnProperty.call(parents, id);
  const keep = (relation: SceneRelation) =>
    !removed.has(labRelationKey(relation)) &&
    !(relation.relation === 'partOf' && ownsParent(relation.frontId));
  result.relations = result.relations.filter(keep);
  if (result.validation)
    result.validation.quarantinedRelations = result.validation.quarantinedRelations.filter((entry) =>
      keep(entry.relation),
    );
  const issues: LabRelationIssue[] = [];
  const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
  const issue = (candidateId: string, code: string, message: string) =>
    issues.push({ candidateId, code, message });
  if (byId.size !== result.candidates.length)
    issue('', 'duplicate-id', '같은 설비 ID가 반복되어 부모를 안전하게 연결할 수 없어요.');
  const proposed: SceneRelation[] = [];
  for (const [childId, parentId] of Object.entries(parents)) {
    const child = byId.get(childId);
    if (!child) {
      issue(childId, 'missing-child', '연결할 세면볼을 찾을 수 없어요.');
      continue;
    }
    if (parentId === null) continue;
    const parent = byId.get(parentId);
    if (!parent) {
      issue(childId, 'missing-parent', '연결할 하부장을 찾을 수 없어요. 부모를 다시 선택해 주세요.');
      continue;
    }
    if (childId === parentId) {
      issue(childId, 'self-parent', '설비를 자기 자신에 연결할 수 없어요.');
      continue;
    }
    if (
      child.kind !== 'basin' ||
      child.mounting !== 'countertop' ||
      !['vanity', 'unknown'].includes(child.basinStyle)
    )
      issue(
        childId,
        'child-support',
        '세면볼의 종류는 세면대, 설치 방식은 상판 위, 지지 구조는 하부장형 또는 모름으로 확인해 주세요.',
      );
    if (parent.kind !== 'vanity' || !['floor', 'wall'].includes(parent.mounting))
      issue(childId, 'parent-support', '부모는 바닥 또는 벽에 설치한 하부장이어야 해요.');
    if (child.reflection !== 'physical' || parent.reflection !== 'physical')
      issue(childId, 'reflection', '세면볼과 하부장을 모두 실제 물체로 확인한 뒤 연결해 주세요.');
    if (child.wall !== 'unknown' && parent.wall !== 'unknown' && child.wall !== parent.wall)
      issue(childId, 'wall-conflict', '세면볼과 하부장의 설치 벽이 달라요. 같은 설비인지 확인해 주세요.');
    if (disconnectedBounds(child, parent))
      issue(
        childId,
        'bounds-disconnected',
        '사진에서 서로 떨어진 세면볼과 하부장은 연결할 수 없어요. 대상 또는 종류를 다시 확인해 주세요.',
      );
    proposed.push({
      frontId: childId,
      behindId: parentId,
      relation: 'partOf',
      provenance: 'user',
      evidence: ['사용자 확인: 이 상판 세면볼은 선택한 하부장의 구성 부품이에요.'],
    });
  }
  const all = [...collectLabRelations(result), ...proposed];
  for (const relation of proposed) {
    if (
      reaches(
        all.filter((edge) => edge !== relation),
        relation.behindId,
        relation.frontId,
      )
    )
      issue(relation.frontId, 'cycle', '부품 연결이 순환해요. 잘못된 기존 연결을 먼저 해제해 주세요.');
    if (
      all.some(
        (edge) =>
          edge !== relation &&
          edge.relation === 'partOf' &&
          edge.frontId === relation.frontId &&
          edge.behindId !== relation.behindId,
      )
    )
      issue(relation.frontId, 'multiple-parents', '세면볼 하나에는 하부장 하나만 연결할 수 있어요.');
  }
  if (result.relations.length + (result.validation?.quarantinedRelations.length ?? 0) + proposed.length > 48)
    issue(
      '',
      'relation-limit',
      '한 번에 기록할 수 있는 관계 48개를 넘었어요. 불필요한 연결을 해제해 주세요.',
    );
  if (!issues.length) {
    result.relations.push(...proposed);
    for (const relation of proposed) {
      const child = byId.get(relation.frontId)!;
      // Selecting a countertop support explicitly stops reusing the bowl as a floor/wall attachment.
      if (child.anchor && child.anchor.kind !== 'countertop-contact') {
        delete child.anchor;
        child.provenance = { ...child.provenance, position: 'user' };
      }
    }
  }
  return { understanding: result, issues };
}

export function applyLabRelationEdits(
  scene: SceneUnderstanding,
  edits: LabRelationEdits,
): SceneUnderstanding {
  const result = previewLabRelationEdits(scene, edits);
  if (result.issues.length) throw new Error(result.issues.map((issue) => issue.message).join(' '));
  return result.understanding;
}
