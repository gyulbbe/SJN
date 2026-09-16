'use client';
import { createBrowserClient } from '@supabase/ssr';
let runtimeConfig: { url: string; publishableKey: string } | undefined;
export function configureBrowserSupabase(config: { url: string; publishableKey: string }) {
  runtimeConfig = config;
}
export function createBrowserSupabase() {
  const url = runtimeConfig?.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = runtimeConfig?.publishableKey ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase 주소와 publishable key가 설정되지 않았어요.');
  return createBrowserClient(url, key);
}
