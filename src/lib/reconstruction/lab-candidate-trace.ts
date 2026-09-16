import type { ReconstructionLabReport } from './lab';
import { reconstructionLabels, type ReconstructionCandidate } from './types';

export const candidateStageLabels = {
  observation: '원후보 관측',
  identity: '형태·거울 역할 재확인',
  appearance: '설비 구조·중복 재확인',
  reflectionRecheck: '거울 표면·반사 구분 재확인',
  classificationResolution: '설비 종류 충돌·추정 유지',
  showerDetails: '샤워 형태·관측 부위 재확인',
  showerInstallation: '샤워 설치 상태·미설치 배관 확인',
  dividerMaterials: '가림막 재질·매달림 확인',
  estimatedLayout: '관계 기반 추정 배치',
  resolution: '통합·반사·부품 판단',
  mounting: '설치 방식',
  support: '설치 벽·지지점',
  placement: '위치·규격 제안',
  bounds: '물리 범위 검증',
  generation: '모형 생성',
} as const;
export type CandidateStageId = keyof typeof candidateStageLabels;
export type CandidateStageStatus =
  'recorded' | 'held' | 'excluded' | 'not-recorded' | 'not-run' | 'missing-output';
export const candidateStageStatusLabels: Record<CandidateStageStatus, string> = {
  recorded: '기록됨',
  held: '보류',
  excluded: '독립 배치 제외',
  'not-recorded': '근거 미기록',
  'not-run': '앞 단계에서 중단',
  'missing-output': '후속 결과 없음',
};
export type LabCandidateStage = {
  id: CandidateStageId;
  status: CandidateStageStatus;
  sources: string[];
  reasons: string[];
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};
export type LabCandidateTrace = {
  version: 1;
  candidateId: string;
  label: string;
  origin: 'original' | 'user' | 'legacy';
  outcome: 'placed' | 'held' | 'excluded' | 'trace-gap';
  stages: LabCandidateStage[];
};
export type LabTraceReport = Pick<
  ReconstructionLabReport,
  'review' | 'fixtures' | 'pipeline' | 'rawReview' | 'rawSegmentationCandidates'
>;

const unique = (values: (string | undefined)[]) => [
  ...new Set(values.filter((v): v is string => !!v?.trim())),
];
const pick = (value: object | undefined, names: readonly string[]): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    names.filter((name) => record[name] !== undefined).map((name) => [name, structuredClone(record[name])]),
  );
};
const observationFields = [
  'kind',
  'detectedLabel',
  'bounds',
  'foot',
  'anchor',
  'mounting',
  'wall',
  'basinStyle',
  'provenance',
  'installation',
];
const placementFields = [
  'kind',
  'face',
  'u',
  'v',
  'baseHeightMm',
  'widthMm',
  'heightMm',
  'depthMm',
  'yawDegrees',
  'orientation',
  'scale',
  'support',
  'mirrorShape',
  'vanityStyle',
  'counterSupport',
  'showerVariant',
  'provenance',
];
const tracesAt = (
  candidate: ReconstructionCandidate | undefined,
  stage: NonNullable<ReconstructionCandidate['trace']>[number]['stage'],
) => candidate?.trace?.filter((entry) => entry.stage === stage) ?? [];

/**
 * Derives a candidate ledger from actual saved records, without solving geometry or inferring lost IDs.
 * An observed candidate is not a confirmed real fixture. Absent records are never invented successes.
 */
export function labCandidateTraces(report: LabTraceReport): LabCandidateTrace[] {
  const pipeline = report.pipeline;
  // A recorded empty model response stays empty; corrected/user observations are not raw model output.
  const raw = pipeline
    ? (pipeline.model?.understanding?.candidates ?? pipeline.automaticUnderstanding?.candidates ?? [])
    : (report.rawSegmentationCandidates ?? report.rawReview?.candidates ?? []);
  const effective = pipeline?.understanding.candidates ?? [];
  const ids = [
    ...new Set([...raw, ...effective, ...report.review.candidates].map((candidate) => candidate.id)),
  ];
  return ids.map((id): LabCandidateTrace => {
    const original = raw.find((candidate) => candidate.id === id);
    const current = effective.find((candidate) => candidate.id === id);
    const applied = report.review.candidates.find((candidate) => candidate.id === id);
    const base = report.rawReview?.candidates.find((candidate) => candidate.id === id);
    const fixture = applied?.fixtureId
      ? report.fixtures.find((entry) => entry.id === applied.fixtureId)
      : undefined;
    const resolution = pipeline?.resolution?.entries.find((entry) => entry.candidateId === id);
    const installationCheck = pipeline?.observedInstallationChecks?.find(
      (entry) => entry.diagnostic.candidateId === id,
    );
    const supportCheck = pipeline?.observedSupportChecks?.find(
      (entry) => entry.diagnostic.candidateId === id,
    );
    const mappingCheck = pipeline?.observedPlacementChecks?.find((entry) => entry.candidateId === id);
    const placement = pipeline?.placements.find((entry) => entry.candidateId === id);
    const modelCheck = pipeline?.modelChecks?.find((entry) => entry.candidateId === id);
    const bounds = applied?.placementReview;
    const estimated = pipeline?.estimatedLayout?.nodes.find((entry) => entry.candidateId === id);
    const appearance =
      pipeline?.quality?.appearance?.decisions.find((entry) => entry.candidateId === id) ??
      pipeline?.estimatedLayout?.appearance?.decisions.find((entry) => entry.candidateId === id);
    const originalIsUser =
      !!original &&
      (('source' in original && original.source === 'user') ||
        ('provenance' in original && original.provenance?.kind === 'user'));
    const origin =
      original && !originalIsUser
        ? ('original' as const)
        : originalIsUser || current?.provenance?.kind === 'user' || applied?.source === 'user'
          ? ('user' as const)
          : ('legacy' as const);
    const kind = original?.kind ?? current?.kind ?? applied?.kind;
    const label = kind && kind !== 'unknown' ? (reconstructionLabels[kind] ?? kind) : '종류 미확인';
    const sourceName = pipeline
      ? pipeline.model?.understanding
        ? 'pipeline.model.understanding'
        : 'pipeline.automaticUnderstanding'
      : report.rawSegmentationCandidates
        ? 'rawSegmentationCandidates'
        : 'rawReview';
    const stages: LabCandidateStage[] = [];
    function stage(
      id: CandidateStageId,
      status: CandidateStageStatus,
      sources: string[],
      reasons: (string | undefined)[],
      input?: Record<string, unknown>,
      output?: Record<string, unknown>,
    ) {
      stages.push({
        id,
        status,
        sources,
        reasons: unique(reasons),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
      });
    }
    stage(
      'observation',
      original && !originalIsUser ? 'recorded' : 'not-recorded',
      original ? [sourceName] : [],
      [
        original && !originalIsUser
          ? '저장된 모델 관측 후보예요. 실제 설비 여부와 배치 성공을 뜻하지 않아요.'
          : origin === 'user'
            ? '사용자가 추가한 후보이며 원모델 검출 결과가 아니에요.'
            : '이전 자료에 원후보 기록이 없어 현재 결과만 확인할 수 있어요.',
      ],
      undefined,
      pick(original ?? applied, observationFields),
    );

    const identity = pipeline?.quality?.identity;
    if (identity) {
      const proposal = identity.validation.proposals.find((entry) => entry.id === id);
      stage(
        'identity',
        proposal ? 'recorded' : 'not-run',
        ['pipeline.quality.identity'],
        proposal
          ? [
              proposal.status === 'quarantined'
                ? '새 관측이 기존 근거와 충돌해 원값을 유지했어요.'
                : proposal.status === 'applied'
                  ? '같은 모델의 별도 형태 관측을 검증한 규칙으로 보정했어요. 독립적인 정답 검증은 아니에요.'
                  : '종류를 확정할 추가 근거가 없거나 기존 값과 같아 유지했어요.',
              ...proposal.issues.map((entry) => entry.message),
            ]
          : ['이 종류는 별도 형태 관측 대상이 아니에요.'],
        proposal ? { original: proposal.original, observation: proposal.observation } : undefined,
        proposal
          ? {
              proposed: proposal.proposed,
              final: proposal.final,
              status: proposal.status,
              source: proposal.source,
              evidenceSource: proposal.evidenceSource,
              rule: proposal.rule,
              ruleRevision: proposal.ruleRevision,
            }
          : undefined,
      );
    }
    if (appearance)
      stage(
        'appearance',
        appearance.status === 'held' ? 'held' : appearance.status === 'duplicate' ? 'excluded' : 'recorded',
        ['pipeline.quality.appearance / pipeline.estimatedLayout.appearance'],
        [
          '같은 모델의 고정 ID 재확인 결과예요. 정답 검증이나 새 설비 검출은 아니에요.',
          ...appearance.reasons,
        ],
        {
          original: structuredClone(appearance.original),
          observation: structuredClone(appearance.observation),
        },
        { status: appearance.status, effective: structuredClone(appearance.effective) },
      );
    const reflection = pipeline?.quality?.reflectionRecheck?.decisions.find(
      (entry) => entry.candidateId === id,
    );
    if (reflection)
      stage(
        'reflectionRecheck',
        reflection.status === 'applied'
          ? 'recorded'
          : reflection.status === 'held'
            ? 'held'
            : reflection.status === 'missing'
              ? 'missing-output'
              : 'not-run',
        ['pipeline.quality.reflectionRecheck.decisions'],
        [
          '원본·전체 사진·확대 영역의 독립 구조 근거로 종류와 실물 여부를 교정하고, 같은 물체 집합의 비대표 후보는 배치를 보류해요.',
          ...reflection.reasons,
        ],
        {
          originalReflection: reflection.originalReflection,
          eligible: reflection.eligible,
          priorKind: reflection.priorKind,
          originalKind: reflection.originalKind,
        },
        {
          status: reflection.status,
          effectiveReflection: reflection.effectiveReflection,
          effectiveKind: reflection.effectiveKind,
          canonicalId: reflection.canonicalId,
          observationRawTextSha256: reflection.observationRawTextSha256,
        },
      );
    const classification = pipeline?.quality?.classificationResolution?.decisions.find(
      (entry) => entry.candidateId === id,
    );
    if (classification)
      stage(
        'classificationResolution',
        'recorded',
        ['pipeline.quality.classificationResolution.decisions'],
        classification.reasons,
        {
          priorKind: classification.priorKind,
          appearanceKind: classification.appearanceKind,
          priorReflection: classification.priorReflection,
        },
        {
          action: classification.action,
          effectiveKind: classification.effectiveKind,
          effectiveReflection: classification.effectiveReflection,
          needsReview: classification.needsReview,
          reasonCodes: classification.reasonCodes,
          targetRawTextSha256: classification.targetRawTextSha256,
        },
      );
    const shower =
      pipeline?.quality?.showerDetails?.observations.find((entry) => entry.id === id) ??
      pipeline?.estimatedLayout?.showerDetails?.find((entry) => entry.id === id);
    if (shower)
      stage(
        'showerDetails',
        'recorded',
        ['pipeline.quality.showerDetails / pipeline.estimatedLayout.showerDetails'],
        [
          '샤워 종류와 사진에서 보이는 부위의 별도 관측이에요. 모든 관측 형태가 자동 적용되는 것은 아니며 실제 적용·보류는 추정 배치 기록에서 확인해요.',
        ],
        { observed: structuredClone(shower) },
        {
          selected: pick(estimated?.selected?.plan, [
            'showerVariant',
            'widthMm',
            'heightMm',
            'depthMm',
            'baseHeightMm',
            'provenance',
          ]),
          placementStatus: estimated?.status,
          modelDecision: estimated?.showerModelDecision,
        },
      );
    const installedness =
      pipeline?.quality?.showerInstallation?.decisions.find((entry) => entry.candidateId === id) ??
      pipeline?.estimatedLayout?.showerInstallationDecisions?.find((entry) => entry.candidateId === id);
    if (installedness)
      stage(
        'showerInstallation',
        installedness.action === 'hold' && estimated?.status === 'held' ? 'held' : 'recorded',
        [
          'pipeline.quality.showerInstallation.decisions',
          'pipeline.estimatedLayout.showerInstallationDecisions',
        ],
        [
          installedness.action === 'hold'
            ? '전체 사진과 확대 관측에서 미설치 구조를 확인해 배치를 보류했어요. 수동으로 확인한 후보는 보호해요.'
            : '설치 상태 원관측을 보존했어요. 불확실한 결과만으로 설비를 제외하지 않아요.',
        ],
        {
          before: structuredClone(installedness.before),
          receipt: structuredClone(installedness.analysis.receipt),
        },
        {
          observation: structuredClone(installedness.analysis.observation),
          rawText: installedness.analysis.rawText,
          rawTextSha256: installedness.analysis.rawTextSha256,
          proposedAfter: structuredClone(installedness.proposedAfter),
          placementStatus: estimated?.status,
        },
      );
    const divider =
      pipeline?.quality?.dividerApplication?.decisions.find((entry) => entry.candidateId === id) ??
      pipeline?.estimatedLayout?.dividerApplication?.decisions.find((entry) => entry.candidateId === id);
    if (divider)
      stage(
        'dividerMaterials',
        divider.status === 'held' ? 'held' : 'recorded',
        ['pipeline.quality.dividerMaterials / dividerApplication'],
        divider.reasons,
        { original: divider.original, observation: divider.observation },
        {
          status: divider.status,
          effective: divider.effective,
          selected: pick(estimated?.selected?.plan, [
            'curtainHardware',
            'widthMm',
            'heightMm',
            'baseHeightMm',
            'provenance',
          ]),
          hangingAnchorMm: estimated?.selected?.hangingAnchorMm,
        },
      );
    const candidateTrace = tracesAt(applied ?? base, 'candidate');
    const componentParent = !pipeline
      ? report.review.candidates.find(
          (candidate) => candidate.evidence.bowlCount?.candidateIds.includes(id) && candidate.id !== id,
        )
      : undefined;
    const excluded = resolution
      ? ['duplicate', 'component', 'reflection'].includes(resolution.disposition)
      : applied?.status === 'ignored' || !!componentParent;
    const resolutionHeld = resolution
      ? ['conflict', 'invalid', 'unknown'].includes(resolution.disposition)
      : candidateTrace.some((entry) => entry.outcome === 'held');
    const rawOnly = !!original && !current && !applied;
    stage(
      'resolution',
      excluded
        ? 'excluded'
        : resolutionHeld
          ? 'held'
          : rawOnly
            ? 'missing-output'
            : resolution || applied
              ? 'recorded'
              : 'not-recorded',
      resolution
        ? ['pipeline.resolution']
        : componentParent
          ? ['review.candidates.evidence.bowlCount.candidateIds']
          : candidateTrace.length
            ? ['review.candidates.trace']
            : applied
              ? ['review.candidates']
              : [],
      resolution?.reasons ??
        (componentParent
          ? ['명시적으로 연결된 세면볼 부품이며 독립 모형으로 중복 생성하지 않아요.']
          : candidateTrace.length
            ? candidateTrace.map((entry) => entry.reason)
            : rawOnly
              ? [
                  '원후보에는 있으나 이후 후보 기록이 없어요. 통합·제외 원인이 기록되지 않아 모델 미검출이나 잘못된 제거로 단정할 수 없어요.',
                ]
              : applied?.status === 'ignored'
                ? ['현재 검토에서 제외된 후보예요. 원자료의 제외 근거를 함께 확인해 주세요.']
                : ['현재 후보 기록은 남아 있어요. 별도의 통합 판단 근거가 없으면 원인을 추정하지 않아요.']),
      pick(original, observationFields),
      resolution
        ? pick(resolution, ['disposition', 'representativeId', 'relatedIds'])
        : componentParent
          ? { representativeId: componentParent.id, disposition: 'component' }
          : pick(applied, ['status', 'reflectionOf']),
    );

    const stopped = excluded || rawOnly;
    const rawMounting =
      original && 'mounting' in original
        ? original.mounting
        : original && 'installation' in original
          ? original.installation?.mode
          : undefined;
    const mode =
      [
        current?.mounting,
        applied?.installation?.mode,
        installationCheck?.installation?.mode,
        base?.installation?.mode,
      ].find((value) => value && value !== 'unknown') ?? 'unknown';
    const mountingSource =
      current?.mounting && current.mounting !== 'unknown'
        ? (current.provenance?.mounting ?? 'model')
        : (applied?.installation?.source ?? installationCheck?.installation?.source ?? 'unrecorded');
    const mountingTrace = tracesAt(applied, 'installation');
    stage(
      'mounting',
      stopped ? 'not-run' : mode && mode !== 'unknown' ? 'recorded' : 'held',
      [
        current ? 'pipeline.understanding' : '',
        applied?.installation ? 'review.candidates.installation' : '',
        installationCheck ? 'pipeline.observedInstallationChecks' : '',
      ].filter(Boolean),
      stopped
        ? ['독립 배치 후보로 이어지지 않았어요.']
        : [
            ...mountingTrace.map((entry) => entry.reason),
            applied?.installation?.reason,
            mode && mode !== 'unknown'
              ? '기록된 설치 방식이며 자동 위치의 유효성을 보장하지 않아요.'
              : '설치 방식 판단 또는 사용자 확인이 필요해요.',
          ],
      pick(original, ['mounting', 'basinStyle', 'installation']),
      {
        ...pick(current, ['mounting', 'basinStyle', 'provenance']),
        ...(!current ? pick(applied?.installation, ['mode', 'basinVariant', 'source']) : {}),
        rawMounting,
        effectiveMounting: mode,
        mountingSource,
      },
    );

    const wall =
      current?.wall && current.wall !== 'unknown'
        ? current.wall
        : (applied?.installation?.wall ?? installationCheck?.installation?.wall);
    const anchor = placement?.anchor ?? current?.anchor;
    const hasSupport = !!(
      anchor ||
      supportCheck?.contact ||
      installationCheck?.installation?.wall ||
      wall ||
      bounds?.requested.support
    );
    stage(
      'support',
      stopped ? 'not-run' : hasSupport ? 'recorded' : 'not-recorded',
      [
        supportCheck ? 'pipeline.observedSupportChecks' : '',
        installationCheck ? 'pipeline.observedInstallationChecks' : '',
        anchor ? 'pipeline.placements.anchor / understanding.anchor' : '',
        wall ? 'installation.wall' : '',
      ].filter(Boolean),
      stopped
        ? ['앞 단계의 독립 배치 제외를 유지해요.']
        : [
            supportCheck?.diagnostic.message,
            installationCheck?.diagnostic.message,
            hasSupport
              ? '벽·기준점의 관측/사용자 출처를 확인해요. 사진 속 위치를 mm로 실측한 값은 아니에요.'
              : '실제 설치 벽·지지점의 확정 기록이 없어요. 사진 bbox 하단을 접지점으로 대신 확정하지 않아요.',
          ],
      pick(original, ['wall', 'foot', 'anchor', 'installation']),
      {
        ...(wall ? { wall } : {}),
        ...(anchor ? { anchor: structuredClone(anchor) } : {}),
        ...(supportCheck ? { supportInspection: structuredClone(supportCheck) } : {}),
        ...(installationCheck ? { installationInspection: structuredClone(installationCheck) } : {}),
      },
    );

    const proposal = bounds?.requested ?? modelCheck?.proposedPlacement ?? placement?.placement;
    const positionTrace = tracesAt(applied, 'placement');
    stage(
      'placement',
      stopped
        ? 'not-run'
        : proposal
          ? 'recorded'
          : placement?.status === 'held' || positionTrace.some((entry) => entry.outcome === 'held')
            ? 'held'
            : 'not-recorded',
      bounds
        ? ['review.candidates.placementReview.requested']
        : modelCheck?.proposedPlacement
          ? ['pipeline.modelChecks.proposedPlacement']
          : placement
            ? ['pipeline.placements']
            : [],
      stopped
        ? ['앞 단계에서 중단되어 위치를 만들지 않았어요.']
        : [
            ...positionTrace.map((entry) => entry.reason),
            ...(placement?.reasons ?? []),
            mappingCheck?.message,
            proposal
              ? '요청한 위치·규격 제안이며 방 안의 유효 배치 또는 원사진 복원 성공과는 별개예요.'
              : '물리 좌표 제안이 없는 이유를 기존 설치·좌표 변환 진단에서 확인해 주세요.',
          ],
      pick(original, ['bounds', 'foot', 'anchor']),
      {
        ...(proposal ? { requested: pick(proposal, placementFields) } : {}),
        ...(mappingCheck ? { mappingInspection: structuredClone(mappingCheck) } : {}),
        ...(placement?.baselineEvidence
          ? { baselineEvidence: structuredClone(placement.baselineEvidence) }
          : {}),
      },
    );

    if (estimated)
      stage(
        'estimatedLayout',
        estimated.status === 'excluded' ? 'excluded' : estimated.selected ? 'recorded' : 'held',
        ['pipeline.estimatedLayout.nodes'],
        [
          '원래 엄격 배치의 관측·보류 기록을 유지한 별도 추정 경로예요. 실측 위치나 품질 통과를 뜻하지 않아요.',
          ...estimated.reasons,
        ],
        { observed: structuredClone(estimated.observed) },
        {
          status: estimated.status,
          selected: structuredClone(estimated.selected),
          alternatives: structuredClone(estimated.alternatives),
          observationChecks: structuredClone(estimated.observationChecks),
        },
      );
    const checked = estimated?.selected?.physicalCheck ?? bounds ?? modelCheck?.result;
    const accepted = estimated?.selected
      ? estimated.selected.physicalCheck.valid
      : bounds
        ? bounds.status === 'accepted'
        : modelCheck?.result.valid;
    stage(
      'bounds',
      stopped || (!proposal && !checked)
        ? 'not-run'
        : checked
          ? accepted
            ? 'recorded'
            : 'held'
          : 'not-recorded',
      estimated?.selected
        ? ['pipeline.estimatedLayout.nodes.selected.physicalCheck']
        : bounds
          ? ['review.candidates.placementReview']
          : modelCheck
            ? ['pipeline.modelChecks']
            : [],
      checked
        ? [
            ...checked.reasons,
            modelCheck?.source === 'source-camera'
              ? '기록된 원사진 카메라 검증이에요. 실제 재투영 수치는 원자료에 있을 때만 확인할 수 있어요.'
              : '입력한 방과 표준 모형의 물리 범위 검사예요. 원사진 카메라 재투영 오차가 아니에요.',
          ]
        : ['확정된 물리 범위 검사 기록이 없어요. 미실행을 통과로 표시하지 않아요.'],
      proposal ? pick(proposal, placementFields) : undefined,
      checked
        ? pick(checked, ['status', 'valid', 'worldBoundsMm', 'overflowMm', 'projectedBounds', 'bboxErrorPx'])
        : undefined,
    );

    const knownHold =
      estimated?.status === 'excluded' ||
      estimated?.status === 'held' ||
      stopped ||
      resolutionHeld ||
      bounds?.status === 'held' ||
      modelCheck?.result.valid === false ||
      placement?.status === 'held' ||
      applied?.requiresReview;
    const missing =
      !fixture && estimated?.status !== 'excluded' && (applied?.status === 'placed' || accepted === true);
    stage(
      'generation',
      fixture ? 'recorded' : missing ? 'missing-output' : knownHold ? 'not-run' : 'not-recorded',
      fixture ? ['review.candidates.fixtureId', 'fixtures'] : applied ? ['review.candidates'] : [],
      [
        fixture
          ? '후보에 연결된 실제 모형이 최종 장면에 있어요. 원사진과 동일한 형태/위치라는 뜻은 아니에요.'
          : missing
            ? '유효 제안 또는 배치 표시가 있지만 연결된 최종 모형이 없어요. 렌더·저장 실패 원인이 이 보고서에 없으므로 단정하지 않아요.'
            : knownHold
              ? '보류/제외된 후보의 모형은 장면에 추가하지 않았어요.'
              : '모형 생성 결과가 기록되지 않았어요. 이전 기록만으로 성공·실패 원인을 추정하지 않아요.',
      ],
      applied ? pick(applied, ['status', 'fixtureId']) : undefined,
      fixture
        ? {
            fixtureId: fixture.id,
            roomPlacement: structuredClone(fixture.roomPlacement),
            reconstruction: pick(fixture.reconstruction, placementFields),
          }
        : undefined,
    );
    return {
      version: 1,
      candidateId: id,
      label,
      origin,
      outcome: fixture
        ? 'placed'
        : excluded || estimated?.status === 'excluded'
          ? 'excluded'
          : rawOnly || missing
            ? 'trace-gap'
            : 'held',
      stages,
    };
  });
}
