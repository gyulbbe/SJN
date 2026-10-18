import type { ServiceLimit, ServiceLimitKind } from './platform/service-limit';

/**
 * What the screens know about a spent Cloudflare daily limit (platform/service-limit.ts): read from the
 * answers the app already gets, never asked for. One notice per kind — the database ('db': sign-in,
 * saving, loading) and AI ('ai') — kept until its time to come back (00:00 UTC, 09:00 in Korea) so a
 * reload still shows it, and cleared by the next normal answer of that kind.
 */

export type LimitGroup = 'db' | 'ai';
export const limitGroup = (limit: ServiceLimit): LimitGroup => (limit.service === 'ai' ? 'ai' : 'db');
export const SERVICE_LIMIT_EVENT = 'sjn-service-limit';
const KEY = 'sjn-service-limit';
const SERVICES: readonly ServiceLimitKind[] = ['db-read', 'db-write', 'db-storage', 'ai'];

function valid(value: unknown): ServiceLimit | null {
  if (!value || typeof value !== 'object') return null;
  const { service, resetAt } = value as { service?: unknown; resetAt?: unknown };
  if (!SERVICES.includes(service as ServiceLimitKind)) return null;
  if (resetAt === undefined) return service === 'db-storage' ? { service } : null;
  if (typeof resetAt !== 'string' || !Number.isFinite(Date.parse(resetAt))) return null;
  return { service: service as ServiceLimitKind, resetAt };
}
/** The limit an answer's body carries (`SERVICE_LIMIT`, or AI's `quota_exhausted` with `limit`). */
export function limitFromBody(body: unknown): ServiceLimit | null {
  return body && typeof body === 'object' ? valid((body as { limit?: unknown }).limit) : null;
}

const live = (limit: ServiceLimit, now: number) => !limit.resetAt || Date.parse(limit.resetAt) > now;
// The browser's storage may be missing or refuse (a private window): then the page's memory holds it.
let memory: ServiceLimit[] = [];
export function readServiceLimits(now = Date.now()): ServiceLimit[] {
  let limits = memory;
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      const stored: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
      limits = Array.isArray(stored) ? stored.flatMap((item) => valid(item) ?? []) : [];
    }
  } catch {
    /* The page's memory, below. */
  }
  return limits.filter((limit) => live(limit, now));
}
function keep(limits: ServiceLimit[]) {
  memory = limits;
  try {
    if (limits.length) globalThis.localStorage?.setItem(KEY, JSON.stringify(limits));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* Shown for this page only. */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SERVICE_LIMIT_EVENT));
}
/** A spent limit, told to every screen (one per kind; a newer one replaces the older). */
export function reportServiceLimit(limit: ServiceLimit) {
  const group = limitGroup(limit);
  const others = readServiceLimits().filter((item) => limitGroup(item) !== group);
  keep([...others, { service: limit.service, ...(limit.resetAt && { resetAt: limit.resetAt }) }]);
}
/** A normal answer of this kind: its notice goes (someone may have lifted the limit). */
export function clearServiceLimit(group: LimitGroup) {
  const limits = readServiceLimits();
  if (limits.some((item) => limitGroup(item) === group))
    keep(limits.filter((item) => limitGroup(item) !== group));
}
/**
 * One answer seen: its limit reported, or, if it went through, that kind's notice cleared. Returns
 * the limit, for the screen's own message.
 */
export function noteServiceAnswer(ok: boolean, body: unknown, group: LimitGroup): ServiceLimit | null {
  const limit = limitFromBody(body);
  if (limit) reportServiceLimit(limit);
  else if (ok) clearServiceLimit(group);
  return limit;
}

const SEOUL = 'Asia/Seoul';
const dayNumber = (date: Date) => {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .split('-')
    .map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};
/**
 * When, in Korea's time: "10월 19일(월) 오전 9시", with "오늘" or "내일" in front when it is today or
 * tomorrow on the browser's clock.
 */
export function formatResetAt(resetAt: string, now = new Date()): string {
  const at = new Date(resetAt);
  const part = (options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL, ...options })
      .formatToParts(at)
      .find((item) => item.type === type)?.value ?? '';
  const month = part({ month: 'numeric' }, 'month');
  const day = part({ day: 'numeric' }, 'day');
  const weekday = part({ weekday: 'short' }, 'weekday');
  const clock = { hour: 'numeric', minute: '2-digit', hour12: true } as const;
  const period = part(clock, 'dayPeriod');
  const hour = part(clock, 'hour');
  const minute = part(clock, 'minute');
  const ahead = dayNumber(at) - dayNumber(now);
  const prefix = ahead === 0 ? '오늘 ' : ahead === 1 ? '내일 ' : '';
  return `${prefix}${month}월 ${day}일(${weekday}) ${period} ${hour}시${minute && minute !== '00' ? ` ${minute}분` : ''}`;
}
const when = (limit: ServiceLimit, now: Date) =>
  limit.resetAt ? formatResetAt(limit.resetAt, now) : '한국 시간 오전 9시';
/** The notice's words: what stopped, when it comes back, what still works. */
export function serviceLimitMessage(limit: ServiceLimit, now = new Date()): string {
  switch (limit.service) {
    case 'db-storage':
      return '서버 저장 공간이 가득 찼어요. 관리자에게 알려 주세요.';
    case 'db-write':
      return `오늘 서버 이용 한도를 모두 써서 저장이 잠시 멈췄어요. ${when(limit, now)} 이후 다시 저장해 주세요. 열려 있는 작업은 이 기기에 보관돼요.`;
    case 'ai':
      return `오늘 AI 이용 한도를 모두 써서 AI 기능(실사 변환·방향 사진·설비 분석)을 쓸 수 없어요. ${when(limit, now)} 이후 다시 시도해 주세요. 편집과 저장은 계속할 수 있어요.`;
    default:
      return `오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요. ${when(limit, now)} 이후 다시 접속해 주세요. 열려 있는 작업은 이 기기에 보관돼요.`;
  }
}
/** Beside an AI button: short. */
export const aiLimitHint = (limit: ServiceLimit, now = new Date()) => `AI 한도 · ${when(limit, now)} 이후`;
