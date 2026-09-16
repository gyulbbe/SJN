import { runFluxExport } from '@/lib/ai-export/server';
import { cloudGemmaErrorResponse } from '@/lib/reconstruction/cloud-gemma-errors';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    return await runFluxExport(request);
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
