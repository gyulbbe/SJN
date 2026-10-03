import { runFluxProductRefine } from '@/lib/ai-export/product-server';
import { cloudGemmaErrorResponse } from '@/lib/reconstruction/cloud-gemma-errors';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    return await runFluxProductRefine(request);
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
