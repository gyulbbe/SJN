import { NextResponse } from 'next/server';
import { authenticated, databaseError, routeError } from '@/lib/supabase/server';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const { client, user } = await authenticated(request);
    const { data, error } = await client
      .from('admin_roles')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();
    databaseError(error);
    return NextResponse.json({ isAdmin: !!data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return routeError(error);
  }
}
