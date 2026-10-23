import { publicCatalogEnvironment } from '@/lib/catalog/public-context';
import { publicMaterials } from '@/lib/catalog/public';
import { serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await publicMaterials(publicCatalogEnvironment(), request);
  } catch (error) {
    return serverError(error);
  }
}
