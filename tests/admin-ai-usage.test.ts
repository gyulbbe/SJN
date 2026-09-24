import { describe, expect, it, vi } from 'vitest';
import { readAiUsage } from '../src/lib/admin/ai-usage';
import { DAILY_FREE_NEURONS } from '../src/lib/admin/ai-usage-contract';

const account = '0123456789abcdef0123456789abcdef';
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_ANALYTICS_TOKEN: 'token-value' };
const now = new Date('2026-09-25T05:30:00Z');
const gemma = '@cf/google/gemma-4-26b-a4b-it';
const flux = '@cf/black-forest-labs/flux-2-klein-4b';

type Group = { count: number; sum: { totalNeurons: number }; dimensions: Record<string, string> };
const answer = (groups: Group[]) =>
  Response.json({ data: { viewer: { accounts: [{ groups }] } }, errors: null });
function fetcher(today: Group[], history: Group[] | Response) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body)) as { query: string };
    if (query.includes('SjnAiUsageToday')) return answer(today);
    return history instanceof Response ? history : answer(history);
  });
}

describe('readAiUsage', () => {
  it('reports today’s remaining free neurons, per-model use and seven UTC days', async () => {
    const fetch = fetcher(
      [
        { count: 30, sum: { totalNeurons: 1500.4 }, dimensions: { modelId: gemma } },
        { count: 4, sum: { totalNeurons: 2400 }, dimensions: { modelId: flux } },
        { count: 2, sum: { totalNeurons: 100 }, dimensions: { modelId: gemma } },
      ],
      [
        { count: 10, sum: { totalNeurons: 800 }, dimensions: { datetimeHour: '2026-09-19T03:00:00Z' } },
        { count: 5, sum: { totalNeurons: 12000 }, dimensions: { datetimeHour: '2026-09-23T10:00:00Z' } },
        { count: 1, sum: { totalNeurons: 9 }, dimensions: { datetimeHour: '2026-09-12T10:00:00Z' } },
      ],
    );
    const usage = await readAiUsage(env, now, fetch);
    expect(usage.usedNeurons).toBeCloseTo(4000.4);
    expect(usage.remainingNeurons).toBeCloseTo(DAILY_FREE_NEURONS - 4000.4);
    expect(usage.requests).toBe(36);
    expect(usage.overageNeurons).toBe(0);
    expect(usage.models.map((m) => [m.modelId, m.requests])).toEqual([
      [flux, 4],
      [gemma, 32],
    ]);
    expect(usage.dayStart).toBe('2026-09-25T00:00:00.000Z');
    expect(usage.resetAt).toBe('2026-09-26T00:00:00.000Z');
    expect(usage.days?.map((d) => d.date)).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
    expect(usage.days?.[0].neurons).toBe(800);
    expect(usage.days?.[4].neurons).toBe(12000);
    // Today's row matches the headline total even if the hourly history lags behind it.
    expect(usage.days?.[6]).toMatchObject({ neurons: usage.usedNeurons, requests: 36 });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-value');
    const body = JSON.parse(String(init.body));
    expect(body.variables).toEqual({ account, from: usage.dayStart, to: now.toISOString() });
    expect(JSON.stringify(usage)).not.toContain('token-value');
  });

  it('never reports negative remaining neurons and estimates the Paid overage', async () => {
    const usage = await readAiUsage(
      env,
      now,
      fetcher([{ count: 90, sum: { totalNeurons: 12500 }, dimensions: { modelId: gemma } }], []),
    );
    expect(usage.remainingNeurons).toBe(0);
    expect(usage.overageNeurons).toBe(2500);
    expect(usage.overageUsd).toBeCloseTo(0.0275);
  });

  it('keeps today’s figure when the seven-day range is unavailable', async () => {
    const usage = await readAiUsage(
      env,
      now,
      fetcher(
        [{ count: 1, sum: { totalNeurons: 50 }, dimensions: { modelId: gemma } }],
        Response.json({ data: null, errors: [{ message: 'time range too large' }] }),
      ),
    );
    expect(usage.usedNeurons).toBe(50);
    expect(usage.days).toBeNull();
  });

  it('asks for configuration without calling Cloudflare', async () => {
    const fetch = vi.fn();
    for (const partial of [{}, { CLOUDFLARE_ACCOUNT_ID: account }, { CLOUDFLARE_ANALYTICS_TOKEN: 'x' }])
      await expect(readAiUsage(partial, now, fetch)).rejects.toMatchObject({ status: 503 });
    await expect(
      readAiUsage({ ...env, CLOUDFLARE_ACCOUNT_ID: 'not-an-account' }, now, fetch),
    ).rejects.toThrow('형식');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [new Response('{}', { status: 403 }), 503, 'Account Analytics'],
    [new Response('{}', { status: 429 }), 429, '5분'],
    [Response.json({ data: null, errors: [{ message: 'not authorized for this account' }] }), 503, '권한'],
    [Response.json({ data: { viewer: { accounts: [] } }, errors: null }), 503, '계정 ID'],
    [Response.json({ data: null, errors: [{ message: 'unknown field totalNeurons' }] }), 503, 'totalNeurons'],
  ])('maps Cloudflare failures to an admin message (%#)', async (response, status, text) => {
    const fetch = vi.fn(async () => response.clone());
    const failure = readAiUsage(env, now, fetch);
    await expect(failure).rejects.toMatchObject({ status });
    await expect(failure).rejects.toThrow(text);
  });
});
