import {
  DAILY_FREE_NEURONS,
  NEURON_USD_PER_THOUSAND,
  type AiUsageDay,
  type AiUsageModel,
  type AiUsageSummary,
} from './ai-usage-contract';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 7;

type Group = { count?: unknown; sum?: { totalNeurons?: unknown }; dimensions?: Record<string, unknown> };
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function usageError(message: string, status = 503): Error {
  return Object.assign(new Error(message), { status });
}

// Account-scoped, sampled ("adaptive") Workers AI analytics. Two small queries so a range the
// plan does not allow for history never hides today's figure.
const TODAY_QUERY = `query SjnAiUsageToday($account: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    groups: aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      count sum { totalNeurons } dimensions { modelId }
    }
  } }
}`;
const HISTORY_QUERY = `query SjnAiUsageHistory($account: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    groups: aiInferenceAdaptiveGroups(limit: 5000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      count sum { totalNeurons } dimensions { datetimeHour }
    }
  } }
}`;

async function query(
  fetcher: Fetcher,
  account: string,
  token: string,
  document: string,
  from: Date,
  to: Date,
): Promise<Group[]> {
  let response: Response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: document,
        variables: { account, from: from.toISOString(), to: to.toISOString() },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw usageError('Cloudflare 사용량 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  if (response.status === 401 || response.status === 403)
    throw usageError('Cloudflare 토큰이 유효하지 않거나 "Account Analytics: 읽기" 권한이 없어요.');
  if (response.status === 429)
    throw usageError('Cloudflare 조회 한도에 도달했어요. 5분 뒤 다시 확인해 주세요.', 429);
  const body = (await response.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: { groups?: Group[] }[] } } | null;
    errors?: { message?: string }[] | null;
  } | null;
  const first = body?.errors?.[0]?.message;
  if (!response.ok || first) {
    if (first && /auth|permission|not allowed|forbidden/i.test(first))
      throw usageError('Cloudflare 토큰에 이 계정의 "Account Analytics: 읽기" 권한이 없어요.');
    // Provider messages never contain the token; keep them short for the admin.
    throw usageError(
      `Cloudflare 사용량을 읽지 못했어요${first ? `: ${first.slice(0, 160)}` : ` (HTTP ${response.status})`}`,
    );
  }
  const accounts = body?.data?.viewer?.accounts;
  if (!accounts?.length)
    throw usageError('Cloudflare 계정을 찾지 못했어요. 계정 ID와 토큰의 계정 범위를 확인해 주세요.');
  return Array.isArray(accounts[0].groups) ? accounts[0].groups : [];
}

const amount = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Reads today's account-wide neurons; the token stays on the server. */
export async function readAiUsage(
  env: Record<string, unknown>,
  now = new Date(),
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<AiUsageSummary> {
  const account = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID.trim() : '';
  const token =
    typeof env.CLOUDFLARE_ANALYTICS_TOKEN === 'string' ? env.CLOUDFLARE_ANALYTICS_TOKEN.trim() : '';
  if (!account || !token)
    throw usageError(
      'AI 사용량 조회가 설정되지 않았어요. CLOUDFLARE_ACCOUNT_ID와 CLOUDFLARE_ANALYTICS_TOKEN을 서버에 등록해 주세요.',
    );
  if (!/^[0-9a-f]{32}$/i.test(account)) throw usageError('CLOUDFLARE_ACCOUNT_ID 형식이 올바르지 않아요.');
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const historyStart = new Date(dayStart.getTime() - (HISTORY_DAYS - 1) * DAY_MS);
  const [today, history] = await Promise.all([
    query(fetcher, account, token, TODAY_QUERY, dayStart, now),
    query(fetcher, account, token, HISTORY_QUERY, historyStart, now).catch(() => null),
  ]);

  const models = new Map<string, AiUsageModel>();
  for (const group of today) {
    const modelId = typeof group.dimensions?.modelId === 'string' ? group.dimensions.modelId : '알 수 없음';
    const entry = models.get(modelId) ?? { modelId, neurons: 0, requests: 0 };
    entry.neurons += amount(group.sum?.totalNeurons);
    entry.requests += amount(group.count);
    models.set(modelId, entry);
  }
  const modelList = [...models.values()].sort((a, b) => b.neurons - a.neurons);
  const usedNeurons = modelList.reduce((total, model) => total + model.neurons, 0);
  const requests = modelList.reduce((total, model) => total + model.requests, 0);

  let days: AiUsageDay[] | null = null;
  if (history) {
    days = Array.from({ length: HISTORY_DAYS }, (_, i) => ({
      date: new Date(historyStart.getTime() + i * DAY_MS).toISOString().slice(0, 10),
      neurons: 0,
      requests: 0,
    }));
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const group of history) {
      const hour = group.dimensions?.datetimeHour;
      const day = typeof hour === 'string' ? byDate.get(hour.slice(0, 10)) : undefined;
      if (!day) continue;
      day.neurons += amount(group.sum?.totalNeurons);
      day.requests += amount(group.count);
    }
    // Today's row uses the same per-model total shown above, so the two never disagree.
    Object.assign(days[days.length - 1], { neurons: usedNeurons, requests });
  }

  const overageNeurons = Math.max(0, usedNeurons - DAILY_FREE_NEURONS);
  return {
    checkedAt: now.toISOString(),
    dayStart: dayStart.toISOString(),
    resetAt: new Date(dayStart.getTime() + DAY_MS).toISOString(),
    freeNeurons: DAILY_FREE_NEURONS,
    usedNeurons,
    remainingNeurons: Math.max(0, DAILY_FREE_NEURONS - usedNeurons),
    requests,
    overageNeurons,
    overageUsd: (overageNeurons / 1000) * NEURON_USD_PER_THOUSAND,
    models: modelList,
    days,
  };
}
