'use client';
import { createBrowserClient } from '@supabase/ssr';

export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase 주소와 publishable key가 설정되지 않았어요.');
  return createBrowserClient(url, key);
}
