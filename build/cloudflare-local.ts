import type { Plugin } from 'vite';

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
}
export function cloudflareRuntimeSource(id: string, projectRoot: string): string | null {
  const root = normalizePath(projectRoot).replace(/\/+$/, '');
  const file = normalizePath(id.split('?')[0]);
  if (file === root + '/src/lib/platform/runtime.ts')
    return `import { env, waitUntil } from 'cloudflare:workers';
export function getRuntimeEnvironment() {
  return { ...env, platform: 'cloudflare'  };
}
export function continueInBackground(task) { waitUntil(task.catch(() => {})); }`;
  return null;
}
export function cloudflareLocalRoutes(projectRoot: string): Plugin {
  return {
    name: 'gongganmiri-cloud-runtime',
    enforce: 'pre',
    load(id) {
      return cloudflareRuntimeSource(id, projectRoot);
    },
  };
}
