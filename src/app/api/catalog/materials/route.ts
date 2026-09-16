import { publicMaterials } from '@/lib/catalog/public';
import { requireD1Environment, serverError } from '@/lib/storage/server';
import type { D1Bindings } from '@/lib/d1/types';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return await publicMaterials(requireD1Environment() as unknown as D1Bindings);
  } catch (error) {
    return serverError(error);
  }
}
