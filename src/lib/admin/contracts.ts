import type { ProjectDocument } from '../types';
export type UserStatus = 'active' | 'suspended';
export type UserRole = 'admin' | 'member';
export type AdminUser = {
  id: string; name: string; email: string; emailVerified: boolean; createdAt: string;
  isAdmin: boolean; status: UserStatus; revision: number; projectCount: number;
};
export type AdminPage<T> = { items: T[]; nextCursor: string | null };
export type AdminProjectSummary = {
  id: string; name: string; ownerId: string; ownerName: string; ownerEmail: string;
  createdAt: string; updatedAt: string; storageRevision: number;
};
export type AdminProjectDetail = {
  document: ProjectDocument;
  owner: { id: string; name: string; email: string };
};
