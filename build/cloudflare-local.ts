import type { Plugin } from 'vite';

const disabledCloudRoute = `
function unavailable() {
  return Response.json({ error: '서버 저장 모드가 꺼져 있어요.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
export { unavailable as GET, unavailable as POST, unavailable as PUT, unavailable as PATCH,
  unavailable as DELETE, unavailable as HEAD, unavailable as OPTIONS };
`;
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
}
/** Legacy Node/Supabase routes remain available in Next; Workers use /api/d1. */
export function cloudflareLocalRouteSource(id: string, projectRoot: string): string | null {
  const root = normalizePath(projectRoot).replace(/\/+$/, '');
  const directory = root + '/src/app/api/cloud/';
  const file = normalizePath(id.split('?')[0]);
  return file.startsWith(directory) && /\/route\.[jt]sx?$/.test(file) ? disabledCloudRoute : null;
}
export function cloudflareRuntimeSource(
  id: string,
  projectRoot: string,
  localDevelopment = false,
): string | null {
  const root = normalizePath(projectRoot).replace(/\/+$/, '');
  const file = normalizePath(id.split('?')[0]);
  if (file === root + '/src/lib/platform/runtime.ts')
    return `import { env, waitUntil } from 'cloudflare:workers';
export function getRuntimeEnvironment() {
  return { ...env, platform: 'cloudflare' ${localDevelopment ? ", APP_ENV: 'local'" : ''} };
}
export function continueInBackground(task) { waitUntil(task.catch(() => {})); }`;
  if (file === root + '/src/lib/platform/supabase-session.ts')
    return `export async function getSupabaseSessionUser() {
      throw Object.assign(new Error('이 환경에서는 D1 서버 저장을 사용해 주세요.'), { status: 503 });
    }`;
  return null;
}
export function cloudflareLocalRoutes(projectRoot: string): Plugin {
  return {
    name: 'gongganmiri-cloud-runtime',
    enforce: 'pre',
    load(id) {
      return (
        cloudflareRuntimeSource(id, projectRoot, process.env.SJN_DEV_LOCAL === '1') ??
        cloudflareLocalRouteSource(id, projectRoot)
      );
    },
  };
}
