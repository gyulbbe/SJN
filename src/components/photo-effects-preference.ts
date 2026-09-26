'use client';

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'sjn-photo-effects';

function read() {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * "사진 효과" for downloads, on by default and remembered in this browser. Someone who turns it off
 * for a plain image (for example to send to a builder) keeps it off next time. Storage may be
 * unavailable (private mode): the choice then lasts for this screen only.
 */
export function usePhotoEffectsPreference() {
  const [enabled, setEnabled] = useState(read);
  const update = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // Not remembered; the current choice still applies.
    }
  }, []);
  return [enabled, update] as const;
}
