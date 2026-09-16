import { d1Route } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return d1Route('catalog', request);
}
