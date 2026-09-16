'use client';
import { useEffect, useState } from 'react';
import { useAccess } from '@/components/app-provider';
/** UI only. The API checks the administrator role on every mutation. */
export function useSharedCatalogAdmin() {
  const { mode, userId, ready } = useAccess();
  const [role, setRole] = useState<{ scope: string; isAdmin: boolean }>();
  const scope = JSON.stringify([mode, userId]);
  useEffect(() => {
    if (mode === 'local' || !ready || !userId) return;
    const controller = new AbortController();
    fetch((mode === 'd1' ? '/api/d1' : '/api/cloud') + '/role', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-SJN-User-Id': userId },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : { isAdmin: false }))
      .then((value) => {
        if (!controller.signal.aborted) setRole({ scope, isAdmin: value.isAdmin === true });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [mode, userId, ready, scope]);
  return mode !== 'local' && role?.scope === scope && role.isAdmin;
}
