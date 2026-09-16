/** Replaced by vinext with request-runtime Cloudflare bindings. */
export function getRuntimeEnvironment(): Record<string, unknown> & { platform: 'node' | 'cloudflare' } {
  return { ...process.env, platform: 'node' };
}

export function continueInBackground(task: Promise<unknown>): void {
  void task.catch(() => {});
}
