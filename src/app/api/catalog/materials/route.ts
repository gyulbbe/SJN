import { authenticatedContext } from '@/lib/admin/server';
import { publicMaterials } from '@/lib/catalog/public';
import { serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await publicMaterials((await authenticatedContext(request)).env);
  } catch (error) {
    return serverError(error);
  }
}
