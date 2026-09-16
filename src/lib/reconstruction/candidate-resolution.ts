import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';

export type CandidateDisposition =
  'fixture' | 'duplicate' | 'component' | 'conflict' | 'reflection' | 'invalid' | 'unknown';
export type CandidateResolutionEntry = {
  candidateId: string;
  disposition: CandidateDisposition;
  representativeId?: string;
  relatedIds: string[];
  reasons: string[];
};
export type CandidateResolution = {
  entries: CandidateResolutionEntry[];
  rawCount: number;
  organizedCount: number;
  duplicateCount: number;
  componentCount: number;
  assemblies: {
    parentId: string;
    componentIds: string[];
    bowlCount?: 1 | 2;
    shape: SceneCandidate['shape'];
    source: 'model-relation' | 'user';
    parentReportedShape?: SceneCandidate['shape'];
    reasons?: string[];
  }[];
};

export function candidateBoxIoU(a: SceneCandidate['bounds'], b: SceneCandidate['bounds']) {
  const intersection =
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = (r: typeof a) => (r.right - r.left) * (r.bottom - r.top);
  return intersection / Math.max(1e-12, area(a) + area(b) - intersection);
}

function contradicts(a: SceneCandidate, b: SceneCandidate) {
  return (
    (['mounting', 'wall', 'basinStyle', 'shape'] as const).some(
      (key) => a[key] !== 'unknown' && b[key] !== 'unknown' && a[key] !== b[key],
    ) ||
    (a.bowlCount !== undefined && b.bowlCount !== undefined && a.bowlCount !== b.bowlCount)
  );
}

/** Observations are immutable. Resolution records why an observation is not another physical fixture. */
export function resolveSceneCandidates(understanding: SceneUnderstanding, automatic?: SceneUnderstanding) {
  const observedIds = new Set(automatic?.candidates.map((item) => item.id) ?? []);
  const placeholder = (item: SceneCandidate) =>
    !observedIds.has(item.id) &&
    item.provenance?.kind === 'user' &&
    item.provenance?.position === 'user' &&
    item.bounds.left === 0 &&
    item.bounds.top === 0 &&
    item.bounds.right === 1 &&
    item.bounds.bottom === 1;
  const effective = structuredClone(understanding.candidates);
  const entries: CandidateResolutionEntry[] = effective.map((item) => {
    const reflected =
      item.reflection === 'reflected' ||
      understanding.relations.some((r) => r.frontId === item.id && r.relation === 'reflectionOf');
    const issues = item.validation?.issues.map((issue) => issue.message) ?? [];
    return {
      candidateId: item.id,
      disposition: reflected
        ? 'reflection'
        : issues.length
          ? 'invalid'
          : item.reflection === 'uncertain'
            ? 'conflict'
            : item.kind === 'unknown'
              ? 'unknown'
              : 'fixture',
      relatedIds: [],
      reasons: reflected
        ? ['반사로 분류한 관측은 실제 설비 수와 독립 배치에서 제외해요. 원래 관측은 보존해요.']
        : issues.length
          ? issues
          : item.reflection === 'uncertain'
            ? ['실제 설비인지 거울 반사인지 확인이 필요해요.']
            : [],
    };
  });
  const entryById = new Map(entries.map((entry) => [entry.candidateId, entry]));
  const byId = new Map(effective.map((item) => [item.id, item]));
  // Prefer a structurally and semantically sound observation with explicit evidence as representative.
  const quality = (item: SceneCandidate) =>
    (item.provenance?.kind === 'user' ? 100 : 0) +
    (item.anchor ? 4 : 0) +
    Number(item.mounting !== 'unknown') +
    Number(item.wall !== 'unknown') +
    Number(item.shape !== 'unknown');
  const ranked = [...effective].sort((a, b) => quality(b) - quality(a));
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i],
      ae = entryById.get(a.id)!;
    if (ae.disposition !== 'fixture') continue;
    for (const b of ranked.slice(i + 1)) {
      const be = entryById.get(b.id)!;
      if (be.disposition !== 'fixture' || a.kind !== b.kind || candidateBoxIoU(a.bounds, b.bounds) < 0.8)
        continue;
      // Two explicitly positioned user fixtures may legitimately share placeholder photo bounds.
      if (placeholder(a) || placeholder(b)) continue;
      if (contradicts(a, b)) {
        for (const [own, other] of [
          [ae, b],
          [be, a],
        ] as const) {
          own.disposition = 'conflict';
          own.relatedIds.push(other.id);
          own.reasons.push(
            `후보 ${other.id}와 같은 위치지만 형태·설치 판단이 달라요. 하나로 임의 병합하지 않아요.`,
          );
        }
      } else {
        be.disposition = 'duplicate';
        be.representativeId = a.id;
        be.relatedIds.push(a.id);
        be.reasons.push(`후보 ${a.id}와 종류·사진 영역이 일치하는 중복 관측이에요. 설비 한 개로 집계해요.`);
        ae.relatedIds.push(b.id);
      }
    }
  }
  // Repeated uncertain observations are still uncertain. This pass changes observation counts only:
  // it never promotes a reflection/depth hypothesis to a physical fixture or fills missing fields.
  const relationObservations = [
    ...understanding.relations,
    ...(understanding.validation?.quarantinedRelations.map((item) => item.relation) ?? []),
  ];
  const relationContext = (id: string) =>
    new Set(
      relationObservations.flatMap((relation) =>
        relation.frontId === id
          ? [JSON.stringify(['front', relation.relation, relation.behindId])]
          : relation.behindId === id
            ? [JSON.stringify(['behind', relation.relation, relation.frontId])]
            : [],
      ),
    );
  const sameUncertainObservation = (a: SceneCandidate, b: SceneCandidate) => {
    if (a.kind !== b.kind || candidateBoxIoU(a.bounds, b.bounds) < 0.8 || contradicts(a, b)) return false;
    // Different contact points can identify distinct, heavily overlapping products.
    if (a.anchor && b.anchor) {
      const width = Math.min(a.bounds.right - a.bounds.left, b.bounds.right - b.bounds.left);
      const height = Math.min(a.bounds.bottom - a.bounds.top, b.bounds.bottom - b.bounds.top);
      if (
        a.anchor.kind !== b.anchor.kind ||
        Math.abs(a.anchor.point.x - b.anchor.point.x) > width * 0.1 ||
        Math.abs(a.anchor.point.y - b.anchor.point.y) > height * 0.1
      )
        return false;
    }
    // A direct relation asserts two observations. Different external relations also prevent merging,
    // including uncertain/quarantined relations: absence of a depth decision is not proof of identity.
    if (
      relationObservations.some(
        (relation) =>
          (relation.frontId === a.id && relation.behindId === b.id) ||
          (relation.frontId === b.id && relation.behindId === a.id),
      )
    )
      return false;
    const ac = relationContext(a.id),
      bc = relationContext(b.id);
    return ac.size === bc.size && [...ac].every((relation) => bc.has(relation));
  };
  const uncertain = ranked.filter(
    (item) =>
      item.reflection === 'uncertain' &&
      item.kind !== 'unknown' &&
      !item.validation?.issues.length &&
      !placeholder(item) &&
      entryById.get(item.id)!.disposition === 'conflict',
  );
  for (let i = 0; i < uncertain.length; i++) {
    const a = uncertain[i],
      ae = entryById.get(a.id)!;
    if (ae.disposition !== 'conflict') continue;
    const members = [a];
    for (const b of uncertain.slice(i + 1)) {
      const be = entryById.get(b.id)!;
      // Check every grouped observation, so an unknown field cannot bridge contradictory reports.
      if (be.disposition !== 'conflict' || !members.every((member) => sameUncertainObservation(member, b)))
        continue;
      be.disposition = 'duplicate';
      be.representativeId = a.id;
      be.relatedIds.push(a.id);
      be.reasons.push(
        `후보 ${a.id}와 같은 불확실한 관측이 반복됐어요. 실제 설비 여부는 아직 확인이 필요해요.`,
      );
      ae.relatedIds.push(b.id);
      // Preserve all warnings in the derived representative; raw observations and IDs remain intact.
      a.uncertainty = [...new Set([...a.uncertainty, ...b.uncertainty])];
      if (a.anchor && b.anchor)
        a.anchor.uncertainty = [...new Set([...a.anchor.uncertainty, ...b.anchor.uncertainty])];
      members.push(b);
    }
  }
  // A mirror, mirrored cabinet, window or door at the same boundary is a kind conflict, not occlusion.
  const panels = new Set(['mirror', 'mirrorCabinet', 'window', 'door']);
  for (let i = 0; i < effective.length; i++)
    for (const b of effective.slice(i + 1)) {
      const a = effective[i],
        ae = entryById.get(a.id)!,
        be = entryById.get(b.id)!;
      if (
        !['fixture', 'conflict'].includes(ae.disposition) ||
        !['fixture', 'conflict'].includes(be.disposition) ||
        a.reflection !== 'physical' ||
        b.reflection !== 'physical' ||
        placeholder(a) ||
        placeholder(b) ||
        a.kind === b.kind ||
        !panels.has(a.kind) ||
        !panels.has(b.kind) ||
        candidateBoxIoU(a.bounds, b.bounds) < 0.8
      )
        continue;
      for (const [own, other] of [
        [ae, b],
        [be, a],
      ] as const) {
        own.disposition = 'conflict';
        own.relatedIds.push(other.id);
        own.reasons.push(`후보 ${other.id}와 외곽이 같지만 종류가 달라요. 실제 종류를 확인해 주세요.`);
      }
    }
  // Explicit component relations preserve the bowl observations without drawing a second cabinet.
  const children = new Map<string, SceneCandidate[]>();
  const userLinkedParents = new Set<string>();
  for (const r of understanding.relations) {
    if (r.relation !== 'partOf') continue;
    const canonical = (id: string) => {
      const entry = entryById.get(id);
      return entry?.disposition === 'duplicate' && entry.representativeId ? entry.representativeId : id;
    };
    const child = byId.get(canonical(r.frontId)),
      parent = byId.get(canonical(r.behindId));
    if (!child || !parent) continue;
    const ce = entryById.get(child.id)!,
      pe = entryById.get(parent.id)!;
    if (ce.disposition === 'component' && ce.representativeId === parent.id) {
      if (r.provenance === 'user') userLinkedParents.add(parent.id);
      continue;
    }
    if (ce.disposition !== 'fixture' || pe.disposition !== 'fixture') continue;
    if (child.kind !== 'basin' || parent.kind !== 'vanity' || child.mounting !== 'countertop') continue;
    if (r.provenance === 'user') userLinkedParents.add(parent.id);
    const list = children.get(parent.id) ?? [];
    list.push(child);
    children.set(parent.id, list);
    ce.disposition = 'component';
    ce.representativeId = parent.id;
    ce.relatedIds.push(parent.id);
    ce.reasons.push(`하부장 ${parent.id}에 속한 세면볼 관측이에요. 하부장 전체의 바닥 기준점과 구분해요.`);
    pe.relatedIds.push(child.id);
  }
  const assemblies: CandidateResolution['assemblies'] = [];
  for (const [id, bowls] of children) {
    const parent = byId.get(id)!;
    const counts = bowls.map((child) => child.bowlCount ?? 1);
    const count = counts.reduce<number>((a, b) => a + b, 0);
    const entry = entryById.get(id)!;
    const declared = parent.bowlCount;
    if (count > 2 || (declared !== undefined && declared !== count)) {
      entry.disposition = 'conflict';
      entry.reasons.push(
        '세면볼 부품 수와 전체 설비의 개수 판단이 맞지 않거나 지원 범위를 넘어요. 개수를 확인해 주세요.',
      );
    } else parent.bowlCount = count as 1 | 2;
    const shapes = new Set(bowls.filter((child) => child.shape !== 'unknown').map((child) => child.shape));
    const parentReportedShape = parent.shape;
    const countUser =
      (declared !== undefined && parent.provenance?.bowlCount === 'user') ||
      bowls.every((child) => child.bowlCount !== undefined && child.provenance?.bowlCount === 'user');
    const shapeUser =
      parent.provenance?.shape === 'user' ||
      bowls.every((child) => child.shape !== 'unknown' && child.provenance?.shape === 'user');
    const assemblyReasons: string[] = [];
    if (shapes.size > 1 && parent.provenance?.shape !== 'user') {
      entry.disposition = 'conflict';
      assemblyReasons.push(
        '서로 다른 세면볼 형태가 관측됐어요. 현재 모형은 같은 형태의 볼만 지원하므로 사용할 형태를 확인해 주세요.',
      );
    } else if (shapes.size === 1 && parent.provenance?.shape !== 'user') {
      parent.shape = [...shapes][0];
      if (parentReportedShape !== 'unknown' && parentReportedShape !== parent.shape)
        assemblyReasons.push(
          '세면볼 형태는 부품 관측에서 가져왔어요. 하부장 본체의 원래 형태 응답과 구분해 보존해요.',
        );
    } else if (parent.provenance?.shape === 'user' && [...shapes].some((shape) => shape !== parent.shape)) {
      assemblyReasons.push(
        '사진 속 부품의 형태와 다른 공통 세면볼 형태를 사용자가 선택했어요. 원래 부품 관측은 보존해요.',
      );
    }
    entry.reasons.push(...assemblyReasons);
    parent.provenance = {
      ...parent.provenance,
      bowlCount: countUser ? 'user' : 'geometry',
      shape: shapeUser ? 'user' : shapes.size === 1 ? 'geometry' : parent.provenance?.shape,
    };
    assemblies.push({
      parentId: id,
      componentIds: bowls.map((child) => child.id),
      bowlCount: parent.bowlCount,
      shape: parent.shape,
      source: userLinkedParents.has(id) || (shapeUser && countUser) ? 'user' : 'model-relation',
      parentReportedShape,
      reasons: assemblyReasons,
    });
  }
  const resolution: CandidateResolution = {
    entries,
    rawCount: effective.length,
    organizedCount: entries.filter((e) => !['duplicate', 'component', 'reflection'].includes(e.disposition))
      .length,
    duplicateCount: entries.filter((e) => e.disposition === 'duplicate').length,
    componentCount: entries.filter((e) => e.disposition === 'component').length,
    assemblies,
  };
  return { effective, resolution };
}
