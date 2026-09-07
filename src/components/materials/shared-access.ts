'use client';

import { useEffect, useState } from 'react';
import { useAccess } from '@/components/app-provider';

/** This controls UI only. Every write also checks the administrator role on the server. */
export function useSharedCatalogAdmin() {
  const { mode } = useAccess();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (mode !== 'supabase') return;
    const controller = new AbortController();
    fetch('/api/cloud/role', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { isAdmin: false }))
      .then((value) => setIsAdmin(value.isAdmin === true))
      .catch(() => {});
    return () => controller.abort();
  }, [mode]);
  return mode === 'supabase' && isAdmin;
}
