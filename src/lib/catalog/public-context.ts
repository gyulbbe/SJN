import { getRuntimeEnvironment } from '../platform/runtime';
import { configuredStorage, type RuntimeSettings } from '../storage/config';
import type { D1Bindings } from '../d1/types';

/** Public catalog reads need D1/R2, but never OAuth configuration or a session. */
export function publicCatalogEnvironment(): D1Bindings {
  const env = getRuntimeEnvironment();
  if (
    configuredStorage(env as RuntimeSettings).reason === 'invalid_configuration' ||
    env.platform !== 'cloudflare' ||
    !env.DB ||
    typeof (env.DB as D1Bindings['DB']).prepare !== 'function' ||
    !env.ASSET_BUCKET ||
    typeof (env.ASSET_BUCKET as D1Bindings['ASSET_BUCKET']).get !== 'function'
  )
    throw Object.assign(new Error('공용 자재 저장소에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'), {
      status: 503,
    });
  return env as unknown as D1Bindings;
}
