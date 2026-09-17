import { defineConfig, defaultClientConditions } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
import { cloudflareLocalRoutes } from './build/cloudflare-local';

// Storage is resolved at request time; missing production bindings block editing until repaired.
export default defineConfig({
  // The runtime's pinned CDN paths are set in the AI worker; do not emit unused WASM assets.
  environments: {
    // Auth is dynamically reached from route handlers. Bundle its server graph once
    // instead of discovering core subpaths after each first request and reloading RSC.
    rsc: { optimizeDeps: { include: ['better-auth'] } },
    client: { resolve: { conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'] } },
  },
  // vinext folds typeof window to "object" for clients; Web Workers have no window.
  worker: {
    // The background-removal runtime is imported lazily inside its module worker.
    format: 'es',
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
      ...(process.env.SJN_DEV_BINDINGS === '1' ? { configPath: 'wrangler.dev.jsonc', persistState: { path: '.wrangler/development' } } : {}),
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
});
