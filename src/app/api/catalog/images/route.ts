import { authenticatedContext } from '@/lib/admin/server';
import { publicImage } from '@/lib/catalog/public';
import { serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await publicImage((await authenticatedContext(request)).env, request);
  } catch (error) {
    return serverError(error);
  }
}
