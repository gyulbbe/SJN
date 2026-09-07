import { defineConfig } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
import { cloudflareLocalRoutes } from './build/cloudflare-local';

// The initial Workers deployment uses browser storage only.
export default defineConfig({
  define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': JSON.stringify('local') },
  // vinext folds typeof window to "object" for clients; Web Workers have no window.
  worker: {
    plugins: () => [
      {
        name: 'gongganmiri-worker-environment',
        configResolved(config) {
          // Worker builds inherit the client's resolved defines. Copy before overriding
          // so the main browser bundle keeps its own window detection.
          const workerDefines = { 'typeof window': JSON.stringify('undefined') };
          // Vite 8's worker config merge overwrites config-hook values with the
          // parent's resolved config, so apply this scoped workaround at this hook.
          Object.assign(config, {
            define: { ...config.define, ...workerDefines },
            environments: {
              ...config.environments,
              client: {
                ...config.environments.client,
                define: { ...config.environments.client.define, ...workerDefines },
              },
            },
          });
        },
      },
    ],
  },
  plugins: [
    cloudflareLocalRoutes(fileURLToPath(new URL('.', import.meta.url))),
    vinext({ prerender: { routes: '*' } }),
    cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
});
