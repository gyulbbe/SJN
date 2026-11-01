import { publicCatalogEnvironment } from '@/lib/catalog/public-context';
import { publicLayouts } from '@/lib/catalog/layouts-server';
import { serverError } from '@/lib/storage/server';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return await publicLayouts(publicCatalogEnvironment());
  } catch (error) {
    return serverError(error);
  }
}
