/**
 * The account's own Workers AI usage (Cloudflare analytics, a few minutes late), next to the ledger: by
 * model for one UTC day, or since a time. Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN
 * from .dev.vars for the request only and never prints or writes them.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/usage.ts [--day 2026-11-04] [--since ISO]
 * Output: test-results/export-photoreal/usage/<day or since>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const vars = (): Record<string, string> => {
  const file = join(ROOT as string, '.dev.vars');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m![1], m![2].replace(/^"|"$/g, '')]),
  );
};

/** Neurons and calls by model between two times. */
export async function accountUsage(from: Date, to: Date) {
  const v = vars();
  const account = v.CLOUDFLARE_ACCOUNT_ID?.trim(),
    token = v.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ANALYTICS_TOKEN missing');
  const query = `query ($account: string!, $from: Time!, $to: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      groups: aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $from, datetime_lt: $to }) {
        count sum { totalNeurons } dimensions { modelId }
      }
    } }
  }`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { account, from: from.toISOString(), to: to.toISOString() } }),
  });
  const body = (await response.json()) as {
    data?: {
      viewer?: {
        accounts?: {
          groups?: { count: number; sum: { totalNeurons: number }; dimensions: { modelId: string } }[];
        }[];
      };
    };
    errors?: { message: string }[];
  };
  if (!response.ok || body.errors?.length)
    throw new Error(`analytics ${response.status}: ${body.errors?.[0]?.message?.slice(0, 160) ?? ''}`);
  const groups = body.data?.viewer?.accounts?.[0]?.groups ?? [];
  const byModel = Object.fromEntries(
    groups
      .map((g) => [
        g.dimensions.modelId,
        { calls: g.count, neurons: Math.round(g.sum.totalNeurons * 10) / 10 },
      ])
      .sort((a, b) => (b[1] as { neurons: number }).neurons - (a[1] as { neurons: number }).neurons),
  ) as Record<string, { calls: number; neurons: number }>;
  const total = Object.values(byModel).reduce((s, m) => s + m.neurons, 0);
  return { from: from.toISOString(), to: to.toISOString(), total: Math.round(total), byModel };
}

if (process.argv[1]?.endsWith('usage.ts') || process.argv[2]?.endsWith('usage.ts')) {
  const since = arg('since');
  const day = arg('day') ?? new Date().toISOString().slice(0, 10);
  const from = since ? new Date(since) : new Date(`${day}T00:00:00Z`);
  const to = since ? new Date() : new Date(Math.min(Date.now(), +new Date(`${day}T00:00:00Z`) + 86_400_000));
  const usage = await accountUsage(from, to);
  mkdirSync(join(OUT as string, 'usage'), { recursive: true });
  writeFileSync(
    join(OUT as string, 'usage', `${(since ?? day).replace(/[:.]/g, '-')}.json`),
    JSON.stringify(usage, null, 1),
  );
  console.log(JSON.stringify(usage, null, 1));
}
