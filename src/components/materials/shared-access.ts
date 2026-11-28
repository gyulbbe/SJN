'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAccess } from '@/components/app-provider';
import { isAdminFor, subscribeAdminRole, watchAdminRole } from '@/lib/admin-role';
/** UI only. Every server request independently checks the administrator role. One check per tab (src/lib/admin-role.ts). */
export function useSharedCatalogAdmin() {
  const { userId, ready, expired } = useAccess();
  const active = ready && !expired && !!userId;
  useEffect(() => {
    if (!active) return;
    return watchAdminRole(userId!);
  }, [active, userId]);
  const snapshot = useCallback(() => isAdminFor(userId), [userId]);
  const isAdmin = useSyncExternalStore(subscribeAdminRole, snapshot, () => false);
  return active && isAdmin;
}
