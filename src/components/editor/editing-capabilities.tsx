'use client';
import { createContext, useContext } from 'react';
import { LockKeyhole } from 'lucide-react';
import { useAccess } from '@/components/app-provider';

export type GuestEditorContext = { requestLogin: (feature: string) => void };
export type EditingCapabilities = {
  writable: boolean;
  guest: boolean;
  requestLogin: (feature: string) => void;
};

// Guest workspace editing never grants access to authenticated account resources.
const EditingCapabilitiesContext = createContext<EditingCapabilities | null>(null);
export const EditingCapabilitiesProvider = EditingCapabilitiesContext.Provider;
export function useEditingCapabilities(): EditingCapabilities {
  const editor = useContext(EditingCapabilitiesContext);
  const access = useAccess();
  return editor ?? { writable: access.writable, guest: false, requestLogin: () => {} };
}

/** Decorative only: button names stay stable for assistive technology and shortcuts. */
export function LoginRequiredIcon({ badge = false }: { badge?: boolean }) {
  return (
    <LockKeyhole
      size={12}
      aria-hidden="true"
      style={
        badge
          ? { position: 'absolute', right: 0, bottom: 0, flexShrink: 0 }
          : { display: 'inline-block', verticalAlign: '-1px', flexShrink: 0, marginLeft: 3 }
      }
    />
  );
}
