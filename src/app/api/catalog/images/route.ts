import { publicImage } from '@/lib/catalog/public';
import { requireD1Environment, serverError } from '@/lib/storage/server';
import type { D1Bindings } from '@/lib/d1/types';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await publicImage(requireD1Environment() as unknown as D1Bindings, request);
  } catch (error) {
    return serverError(error);
  }
}
