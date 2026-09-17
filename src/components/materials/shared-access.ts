'use client';
import { useEffect, useState } from 'react';
import { useAccess } from '@/components/app-provider';
/** UI only. Every server request independently checks the administrator role. */
export function useSharedCatalogAdmin() {
  const { userId, ready, expired } = useAccess();
  const [role, setRole] = useState<{ scope: string; isAdmin: boolean }>();
  const scope = JSON.stringify(['d1', userId]);
  useEffect(() => {
    if (!ready || !userId || expired) return;
    let controller: AbortController | undefined;
    function refresh() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      void fetch('/api/d1/role', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-SJN-User-Id': userId! },
        signal: current.signal,
      })
        .then(async (response) => {
          if (response.ok) return response.json();
          if (response.status === 401 || response.status === 403) return { isAdmin: false };
          throw new Error('권한 연결 확인 실패');
        })
        .then((value) => {
          if (!current.signal.aborted) setRole({ scope, isAdmin: value.isAdmin === true });
        })
        .catch(() => {
          /* Preserve an already confirmed editor during transient connectivity failures; the API still authorizes every operation. */
        });
    }
    function visible() {
      if (document.visibilityState === 'visible') refresh();
    }
    refresh();
    const timer = window.setInterval(visible, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('sjn-admin-role-changed', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('sjn-admin-role-changed', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [userId, ready, expired, scope]);
  return ready && !expired && !!userId && role?.scope === scope && role.isAdmin;
}
