'use client';

import {
  candidateStageLabels,
  candidateStageStatusLabels,
  labCandidateTraces,
  type LabCandidateTrace,
  type LabTraceReport,
} from '@/lib/reconstruction/lab-candidate-trace';

const outcomeLabels = {
  placed: '실제 모형 있음',
  held: '보류·확인 필요',
  excluded: '독립 배치 제외',
  'trace-gap': '후속 기록 확인 필요',
} as const;

export function CandidateTraceDetails({ trace }: { trace: LabCandidateTrace }) {
  return (
    <details data-candidate-trace={trace.candidateId}>
      <summary>
        {trace.label} · {trace.candidateId} · {outcomeLabels[trace.outcome]}
      </summary>
      <p>
        {trace.origin === 'user'
          ? '사용자 추가 · AI 검출 아님'
          : trace.origin === 'legacy'
            ? '이전 자료 · 원관측 미기록'
            : '저장된 원관측과 이번 결과를 연결했어요.'}
      </p>
      <ol>
        {trace.stages.map((stage) => (
          <li key={stage.id} data-trace-stage={stage.id} data-trace-status={stage.status}>
            <details>
              <summary>
                {candidateStageLabels[stage.id]} · {candidateStageStatusLabels[stage.status]}
              </summary>
              {stage.reasons.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
              <small>기록 위치: {stage.sources.join(', ') || '별도 기록 없음'}</small>
              {(stage.input || stage.output) && (
                <pre
                  style={{
                    maxHeight: 240,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {JSON.stringify({ input: stage.input, output: stage.output }, null, 2)}
                </pre>
              )}
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Completed-result diagnostics only. Pending form edits never rewrite observation history. */
export function LabCandidateTracePanel({ report }: { report: LabTraceReport }) {
  const traces = labCandidateTraces(report);
  return (
    <details data-testid="lab-candidate-traces" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <summary>후보별 진행 근거 · {traces.length}개 기록</summary>
      <p>
        완료된 이 결과의 기록이에요. 입력 중인 교정은 다시 결과를 만들 때 반영돼요. 기록됨은 인식 정답이나
        자동 배치 성공을 뜻하지 않아요.
      </p>
      {!traces.length && <p>저장된 후보 기록이 없어요. 사진에 설비가 없다는 뜻은 아니에요.</p>}
      {traces.map((trace) => (
        <CandidateTraceDetails key={trace.candidateId} trace={trace} />
      ))}
    </details>
  );
}
