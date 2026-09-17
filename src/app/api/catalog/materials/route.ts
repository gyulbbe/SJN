import { publicCatalogEnvironment } from '@/lib/catalog/public-context';
import { publicMaterials } from '@/lib/catalog/public';
import { serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return await publicMaterials(publicCatalogEnvironment());
  } catch (error) {
    return serverError(error);
  }
}
