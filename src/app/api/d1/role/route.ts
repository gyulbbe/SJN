import { d1Route } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return d1Route('role', request); }
