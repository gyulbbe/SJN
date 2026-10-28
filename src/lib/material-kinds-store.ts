'use client';
import { useSyncExternalStore } from 'react';
import { defaultKindRows, kindLabel, type MaterialKindRow } from './material-kinds';
import { categoryLabels, type MaterialKind } from './types';

/**
 * The 위생도기 kinds in this tab: the built-in ones until a list's first page (or the catalog) brings the
 * administrator's list (migration 0012). No request of its own.
 */
let kinds: MaterialKindRow[] = defaultKindRows();
const listeners = new Set<() => void>();
export function setMaterialKinds(rows: MaterialKindRow[]) {
  if (JSON.stringify(rows) === JSON.stringify(kinds)) return;
  kinds = rows;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => kinds;
const serverSnapshot = () => kinds;
/** Every known kind (hidden ones too), in order, 기타 last. */
export const useMaterialKinds = () => useSyncExternalStore(subscribe, snapshot, serverSnapshot);
/** What a list or the form offers: tiles, then the kinds in use (and `keep`, a kind already chosen). */
export function pickableKinds(rows: readonly MaterialKindRow[], keep?: MaterialKind) {
  return [
    { code: 'tile' as MaterialKind, name: categoryLabels.tile },
    ...rows.filter((row) => row.active || row.code === keep),
    ...(keep && keep !== 'tile' && !rows.some((row) => row.code === keep)
      ? [{ code: keep, name: kindLabel(keep, rows) }]
      : []),
  ];
}
/** A kind's name with this tab's list. */
export const useKindLabel = () => {
  const rows = useMaterialKinds();
  return (code: MaterialKind) => kindLabel(code, rows);
};
