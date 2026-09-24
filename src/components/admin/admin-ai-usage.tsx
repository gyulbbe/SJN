'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AiUsageSummary } from '@/lib/admin/ai-usage-contract';
import { useAccess } from '@/components/app-provider';
import AdminShell from './admin-shell';
import { adminRequest } from './data';

const MODEL_LABELS: Record<string, string> = {
  '@cf/google/gemma-4-26b-a4b-it': '사진 분석 · Gemma',
  '@cf/black-forest-labs/flux-2-klein-4b': 'AI 현장 사진 · FLUX.2 klein 4B',
};
const neurons = (value: number) => Math.round(value).toLocaleString('ko-KR');
const kst = (iso: string, options: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', ...options });

function untilReset(resetAt: string, now: number) {
  const left = Date.parse(resetAt) - now;
  if (left <= 0) return '초기화됨 · 새로고침해 주세요';
  const minutes = Math.ceil(left / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

export default function AdminAiUsage() {
  const { userId } = useAccess();
  const [usage, setUsage] = useState<AiUsageSummary>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!userId) return;
      setBusy(true);
      setError('');
      try {
        const result = await adminRequest<AiUsageSummary>('/api/admin/ai-usage', userId, { signal });
        if (!signal?.aborted) setUsage(result);
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : 'AI 사용량을 불러오지 못했어요.');
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [userId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const usedRatio = usage ? Math.min(1, usage.usedNeurons / usage.freeNeurons) : 0;
  const barColor =
    usedRatio >= 0.9
      ? 'bg-[color:var(--danger)]'
      : usedRatio >= 0.7
        ? 'bg-amber-500'
        : 'bg-[color:var(--accent)]';
  const dayMax = Math.max(usage?.freeNeurons ?? 1, ...(usage?.days ?? []).map((day) => day.neurons));

  return (
    <AdminShell title="AI 사용량">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[color:var(--muted)]">
          Cloudflare Workers AI 계정 전체의 오늘(UTC 기준) 뉴런 사용량이에요. 무료 할당은 매일 한국 시간 오전
          9시에 초기화돼요.
        </p>
        <button className="btn" disabled={busy || !userId} onClick={() => void load()}>
          {busy ? '확인 중…' : '새로고침'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-[var(--radius-sm)] border border-[color:var(--danger)] bg-[color:var(--paper)] p-4 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {usage && (
        <>
          <section
            aria-label="오늘 남은 무료 뉴런"
            className="mt-6 rounded-[var(--radius)] border border-[color:var(--line)] bg-[color:var(--paper)] p-6 shadow-[var(--shadow-sm)]"
          >
            <p className="text-sm font-semibold text-[color:var(--muted)]">오늘 남은 무료 뉴런</p>
            <div className="mt-1 text-4xl font-bold tabular-nums text-[color:var(--ink)]">
              {neurons(usage.remainingNeurons)}
              <span className="ml-2 text-lg font-medium text-[color:var(--muted)]">
                / {neurons(usage.freeNeurons)}
              </span>
            </div>
            <div
              className="mt-4 h-3 overflow-hidden rounded-full bg-[color:var(--surface-soft)]"
              role="progressbar"
              aria-label="오늘 사용한 비율"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedRatio * 100)}
            >
              <div className={`h-full ${barColor}`} style={{ width: `${usedRatio * 100}%` }} />
            </div>
            <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-[color:var(--muted)]">오늘 사용</dt>
                <dd className="font-semibold tabular-nums">
                  {neurons(usage.usedNeurons)} 뉴런 ({Math.round(usedRatio * 100)}%)
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--muted)]">AI 호출</dt>
                <dd className="font-semibold tabular-nums">{neurons(usage.requests)}회</dd>
              </div>
              <div>
                <dt className="text-[color:var(--muted)]">초기화까지</dt>
                <dd className="font-semibold">
                  {untilReset(usage.resetAt, now)} (
                  {kst(usage.resetAt, { month: 'numeric', day: 'numeric', hour: 'numeric' })})
                </dd>
              </div>
            </dl>
            {usage.overageNeurons > 0 && (
              <div className="mt-4 text-sm text-[color:var(--danger)]">
                무료 할당을 {neurons(usage.overageNeurons)} 뉴런 넘었어요. Workers Paid라면 약 $
                {usage.overageUsd.toFixed(3)}가 과금되고, Workers Free라면 초기화 전까지 AI 요청이 실패해요.
              </div>
            )}
          </section>

          <section aria-label="모델별 사용" className="mt-8">
            <h2 className="mb-3 text-lg font-semibold">오늘 모델별 사용</h2>
            {usage.models.length ? (
              <ul className="divide-y divide-[color:var(--line)] rounded-[var(--radius)] border border-[color:var(--line)] bg-[color:var(--paper)]">
                {usage.models.map((model) => (
                  <li
                    key={model.modelId}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  >
                    <span>
                      <span className="font-semibold">{MODEL_LABELS[model.modelId] ?? model.modelId}</span>
                      {MODEL_LABELS[model.modelId] && (
                        <span className="ml-2 text-xs text-[color:var(--muted)]">{model.modelId}</span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      {neurons(model.neurons)} 뉴런 · {neurons(model.requests)}회
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-[color:var(--muted)]">오늘은 아직 AI 호출 기록이 없어요.</p>
            )}
          </section>

          <section aria-label="최근 7일" className="mt-8">
            <h2 className="mb-3 text-lg font-semibold">최근 7일</h2>
            {usage.days ? (
              <ol className="space-y-2">
                {usage.days.map((day) => (
                  <li key={day.date} className="grid grid-cols-[4.5rem_1fr_7rem] items-center gap-3 text-sm">
                    <span className="tabular-nums text-[color:var(--muted)]">
                      {day.date.slice(5).replace('-', '/')}
                    </span>
                    <span className="relative h-2.5 overflow-hidden rounded-full bg-[color:var(--surface-soft)]">
                      <span
                        className={`absolute inset-y-0 left-0 ${day.neurons > usage.freeNeurons ? 'bg-[color:var(--danger)]' : 'bg-[color:var(--accent)]'}`}
                        style={{ width: `${(day.neurons / dayMax) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">{neurons(day.neurons)} 뉴런</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-[color:var(--muted)]">
                Cloudflare가 7일 기록을 돌려주지 않아 오늘 값만 표시해요.
              </p>
            )}
          </section>

          <div className="mt-8 text-xs leading-relaxed text-[color:var(--muted)]">
            Cloudflare 계정 전체 합계로, 같은 계정의 다른 Worker 사용량도 포함돼요. 표본 집계라 실제 청구와
            조금 다를 수 있고 몇 분 늦게 반영될 수 있어요. 날짜는 UTC 기준이에요. 마지막 확인:{' '}
            {kst(usage.checkedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </>
      )}
    </AdminShell>
  );
}
