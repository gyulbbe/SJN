'use client';
import { createContext, useContext } from 'react';
import { getRepositories, type Repositories } from '@/lib/repositories';
import type { GuestRepositories } from '@/lib/guest/session';
export type EditorRepositories = Repositories | GuestRepositories;
const RepositoryContext = createContext<EditorRepositories | null>(null);
export const RepositoryProvider = RepositoryContext.Provider;
/** Explicit per-editor repositories; never replace another workspace's global repository. */
export function useRepositories() {
  return useContext(RepositoryContext) ?? getRepositories();
}

const AdminProjectScopeContext = createContext<string | null>(null);
export const AdminProjectScopeProvider = AdminProjectScopeContext.Provider;
export function useAdminProjectScope() {
  return useContext(AdminProjectScopeContext);
}
