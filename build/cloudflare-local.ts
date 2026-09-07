import type { Plugin } from 'vite';

const disabledCloudRoute = `
function unavailable() {
  return Response.json(
    { error: '서버 저장 모드가 꺼져 있어요.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
export {
  unavailable as GET,
  unavailable as POST,
  unavailable as PUT,
  unavailable as PATCH,
  unavailable as DELETE,
  unavailable as HEAD,
  unavailable as OPTIONS,
};
`;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

export function cloudflareLocalRouteSource(id: string, projectRoot: string): string | null {
  const directory = `${normalizePath(projectRoot).replace(/\/+$/, '')}/src/app/api/cloud/`;
  const file = normalizePath(id.split('?')[0]);
  if (!file.startsWith(directory) || !/\/route\.[jt]sx?$/.test(file)) return null;
  return disabledCloudRoute;
}

export function assertCloudflareLocalMode(mode: string | undefined): void {
  if (mode !== undefined && mode !== 'local') {
    throw new Error('현재 Cloudflare 배포는 local 저장 모드만 지원합니다.');
  }
}

export function cloudflareLocalRoutes(projectRoot: string): Plugin {
  return {
    name: 'gongganmiri-local-cloud-routes',
    enforce: 'pre',
    // Replace the complete module before Vite follows its sharp/Supabase imports.
    // The original Next.js route files remain available for future server storage.
    load(id) {
      return cloudflareLocalRouteSource(id, projectRoot);
    },
    configResolved() {
      assertCloudflareLocalMode(process.env.NEXT_PUBLIC_STORAGE_MODE);
    },
  };
}
