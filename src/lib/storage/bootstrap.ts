import { blockedStatus, type StorageStatus, STORAGE_MESSAGES } from './config';

/** Resolves once: a late server response cannot change this workspace. */
export async function discoverStorage(
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<StorageStatus> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<StorageStatus>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(blockedStatus('initialization_timeout'));
      controller.abort();
    }, options.timeoutMs ?? 5000);
  });
  const request = (async () => {
    try {
      const response = await (options.fetcher ?? fetch)('/api/storage/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) return blockedStatus('connection_failed');
      const value = (await response.json()) as StorageStatus;
      if (
        !['local', 'd1', 'supabase'].includes(value.mode) ||
        typeof value.ready !== 'boolean' ||
        (value.mode === 'local' && !value.ready) ||
        !Object.hasOwn(STORAGE_MESSAGES, value.reason)
      )
        return blockedStatus('invalid_configuration');
      return value;
    } catch {
      return blockedStatus(timedOut ? 'initialization_timeout' : 'connection_failed');
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
