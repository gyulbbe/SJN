import { runFluxCheck } from '@/lib/ai-export/check-server';
import { cloudGemmaErrorResponse } from '@/lib/reconstruction/cloud-gemma-errors';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    return await runFluxCheck(request);
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
