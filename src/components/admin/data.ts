'use client';
import { useEffect, useState } from 'react';
import type { AdminPage } from '@/lib/admin/contracts';
import { useAccess } from '@/components/app-provider';

export class AdminRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export async function adminRequest<T>(url: string, userId: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-SJN-User-Id': userId, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || data?.code === 'account_suspended')
      window.dispatchEvent(
        new CustomEvent('sjn-auth-expired', { detail: { suspended: data?.code === 'account_suspended' } }),
      );
    if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('sjn-admin-role-changed'));
    throw new AdminRequestError(
      data?.error ?? '관리자 요청을 처리하지 못했어요. 다시 시도해 주세요.',
      response.status,
    );
  }
  return data as T;
}
export function useAdminPage<T>(endpoint: string, query: string, revision: number) {
  const { userId } = useAccess();
  const [data, setData] = useState<AdminPage<T>>({ items: [], nextCursor: null });
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState('');
  const currentScope = `${userId}:${query}:${revision}`;
  useEffect(() => {
    setCursor(undefined);
  }, [currentScope]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const requestedCursor = scope === currentScope ? cursor : undefined;
    setBusy(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams(query);
      if (requestedCursor) params.set('cursor', requestedCursor);
      void adminRequest<AdminPage<T>>(`${endpoint}?${params}`, userId, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setData((previous) =>
            requestedCursor ? { ...result, items: [...previous.items, ...result.items] } : result,
          );
          setScope(currentScope);
          setError('');
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : '목록을 불러오지 못했어요.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // scope is a response marker, not a request trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, query, revision, userId, cursor, currentScope]);
  return {
    data: scope === currentScope ? data : { items: [] as T[], nextCursor: null },
    busy,
    error,
    more: () => setCursor(data.nextCursor ?? undefined),
  };
}
