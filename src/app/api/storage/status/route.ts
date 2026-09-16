import { storageStatus } from '@/lib/storage/server';
import { blockedStatus } from '@/lib/storage/config';
export const dynamic = 'force-dynamic';
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      storageStatus(),
      new Promise<ReturnType<typeof blockedStatus>>((resolve) => {
        timer = setTimeout(() => resolve(blockedStatus('initialization_timeout')), 4500);
      }),
    ]);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } finally { clearTimeout(timer); }
}
