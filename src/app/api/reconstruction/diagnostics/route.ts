import { authenticatedContext } from '@/lib/admin/server';
import { serverError } from '@/lib/storage/server';
import { diagnosticArchiveRequest } from '@/lib/reconstruction/diagnostic-archive-server';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  try {
    return await diagnosticArchiveRequest(await authenticatedContext(request), request);
  } catch (error) {
    return serverError(error);
  }
}
export const GET = handle;
export const POST = handle;
