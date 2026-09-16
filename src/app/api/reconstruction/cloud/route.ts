import { cloudGemmaAvailability, runCloudGemmaModel } from '@/lib/reconstruction/cloud-gemma-server';
import { cloudGemmaErrorResponse } from '@/lib/reconstruction/cloud-gemma-errors';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return Response.json(await cloudGemmaAvailability(request), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
export async function POST(request: Request) {
  try {
    return Response.json(await runCloudGemmaModel(request), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return cloudGemmaErrorResponse(error, request.signal);
  }
}
