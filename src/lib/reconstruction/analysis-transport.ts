import { openDB } from 'idb';
import type { AnalysisProvider } from './analysis-provider';
import { validAnalysisResponse } from './analysis-provider';
import { cloudOperationCacheIdentity } from './cloud-gemma-cache-contract';

const endpoint = '/api/reconstruction/cloud';
const cacheVersion = 'cloud-stage-v1';
const maxRecords = 64;
type Cached = { key: string; savedAt: number; checksum: string; value: Record<string, unknown> };
type Flight = { controller: AbortController; promise: Promise<Record<string, unknown>>; users: number };
const flights = new Map<string, Flight>();
const memory = new Map<string, Cached>();

function cancelled(signal?: AbortSignal | null) { signal?.throwIfAborted(); }
async function database() {
  return openDB('sjn-reconstruction-cloud-stages', 1, {
    upgrade(db) { db.createObjectStore('stages', { keyPath: 'key' }).createIndex('savedAt', 'savedAt'); },
  });
}
async function read(key: string): Promise<Cached | undefined> {
  try {
    const db = await database();
    try { return (await db.get('stages', key)) ?? memory.get(key); } finally { db.close(); }
  } catch { return memory.get(key); }
}
async function save(record: Cached) {
  memory.set(record.key, record);
  while (memory.size > maxRecords) memory.delete(memory.keys().next().value!);
  try {
    const db = await database();
    try {
      const tx = db.transaction('stages', 'readwrite');
      await tx.store.put(record);
      let excess = (await tx.store.count()) - maxRecords;
      for (let cursor = await tx.store.index('savedAt').openCursor(); cursor && excess > 0; cursor = await cursor.continue(), excess--)
        await cursor.delete();
      await tx.done;
    } finally { db.close(); }
    return true;
  } catch { return false; }
}
const sha = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
async function requestKey(form: FormData, scope: string) {
  const parts: [string, string][] = [];
  for (const [key, value] of form.entries()) parts.push([key, typeof value === 'string' ? value : `${value.type}:${value.size}:${await sha(await value.arrayBuffer())}`]);
  parts.sort(([a], [b]) => a.localeCompare(b));
  return sha(new TextEncoder().encode(JSON.stringify({ cacheVersion, operation: cloudOperationCacheIdentity(form.get('operation')), scope, parts })).buffer);
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    cancelled(signal);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('분석을 취소했어요.', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function retryDelay(response: Response, body: Record<string, unknown>, attempt: number, now = Date.now()): number | null {
  if (![429, 503].includes(response.status) || body.retryable !== true || attempt >= 2) return null;
  const header = response.headers.get('Retry-After');
  const seconds = header === null ? NaN : Number(header);
  const dateDelay = header === null ? NaN : Date.parse(header) - now;
  const supplied = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
  const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(supplied) ? supplied : 0,
    typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) ? body.retryAfterMs : 0);
  // A long requested wait is returned to the user, never shortened into an early retry.
  return delay <= 120_000 ? delay : null;
}

async function execute(form: FormData, key: string, signal: AbortSignal) {
  const cached = await read(key);
  cancelled(signal);
  if (cached && cached.key === key && Date.now() - cached.savedAt < 24 * 60 * 60_000 && cached.checksum === await sha(new TextEncoder().encode(JSON.stringify({ key, value: cached.value })).buffer) && validAnalysisResponse(cached.value, 'cloudflare-workers-ai')) {
    const value = structuredClone(cached.value);
    value.measurement = { ...(value.measurement as object), cacheHit: true, requestMs: 0, inferenceCalls: 0, httpAttempts: 0, unknownAttempts: 0 };
    return value;
  }
  let inferenceCalls = 0, unknownAttempts = 0;
  for (let attempt = 0; ; attempt++) {
    cancelled(signal);
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', body: form, signal, headers: { 'X-SJN-Analysis': 'cloud-explicit' } });
    const body = await response.json() as Record<string, unknown>;
    cancelled(signal);
    const diagnostics = body.diagnostics as Record<string, unknown> | undefined;
    const reported = (response.ok ? body.measurement : diagnostics) as Record<string, unknown> | undefined;
    const calls = reported?.inferenceCalls;
    if (typeof calls === 'number' && Number.isInteger(calls) && calls >= 0) inferenceCalls += calls;
    else unknownAttempts++;
    if (!response.ok) {
      const delay = retryDelay(response, body, attempt);
      if (delay !== null) { await wait(delay, signal); continue; }
      throw Object.assign(new Error(typeof body.error === 'string' ? body.error : '설비 분석 요청에 실패했어요.'), {
        status: response.status, code: body.code, retryAfter: response.headers.get('Retry-After'), diagnostics: { ...diagnostics, httpAttempts: attempt + 1, inferenceCalls, unknownAttempts },
      });
    }
    if (!validAnalysisResponse(body, 'cloudflare-workers-ai')) throw new Error('설비 분석 공급자 정보를 확인할 수 없어요.');
    body.measurement = { ...(body.measurement as object), cacheHit: false, httpAttempts: attempt + 1, inferenceCalls, unknownAttempts };
    const persisted = await save({ key, savedAt: Date.now(), value: body, checksum: await sha(new TextEncoder().encode(JSON.stringify({ key, value: body })).buffer) });
    cancelled(signal);
    // Keep the checksummed cache value immutable when adding a response-only storage notice.
    return persisted ? body : { ...body, measurement: { ...(body.measurement as object), cacheWarning: '저장 공간이 부족해 완료 단계는 이 탭에서만 재사용해요.' } };
  }
}

async function subscribe(key: string, form: FormData, signal?: AbortSignal | null) {
  cancelled(signal);
  let flight = flights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    flight = { controller, users: 0, promise: Promise.resolve({}) };
    const current = flight;
    current.promise = execute(form, key, AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]))
      .finally(() => { if (flights.get(key) === current) flights.delete(key); });
    flights.set(key, current);
  }
  const selected = flight;
  selected.users++;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true; signal?.removeEventListener('abort', abort); selected.users--;
      if (!selected.users) selected.controller.abort();
      callback();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new DOMException('분석을 취소했어요.', 'AbortError')));
    signal?.addEventListener('abort', abort, { once: true });
    selected.promise.then(value => finish(() => resolve(structuredClone(value))), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}

/** Cloud stages share work within this browser tab; retired providers are rejected before any request. */
export async function fetchAnalysis(provider: AnalysisProvider, init: RequestInit): Promise<Response> {
  if (provider !== 'cloudflare-workers-ai') throw new Error('기존 로컬 AI 분석은 종료됐어요. Gemma 분석을 선택해 주세요.');
  if (!(init.body instanceof FormData)) throw new Error('설비 분석 입력 형식이 올바르지 않아요.');
  cancelled(init.signal);
  // Check current access before a persistent hit, so a prior signed-in user's cache cannot bypass auth.
  const status = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin', signal: init.signal });
  const available = await status.json();
  cancelled(init.signal);
  if (!status.ok || available.available !== true || typeof available.cacheScope !== 'string')
    throw new Error(available.reason ?? available.error ?? '서버 설비 분석 연결을 확인해 주세요.');
  const key = await requestKey(init.body, available.cacheScope);
  const result = await subscribe(key, init.body, init.signal);
  return Response.json(result);
}

export function cancelActiveCloudAnalysis() {
  for (const flight of flights.values()) flight.controller.abort();
  flights.clear();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', cancelActiveCloudAnalysis);
