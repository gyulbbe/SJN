import { runDirectionPhoto } from '@/lib/direction-photo/server';
import { cloudGemmaErrorResponse } from '@/lib/reconstruction/cloud-gemma-errors';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    return await runDirectionPhoto(request);
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
