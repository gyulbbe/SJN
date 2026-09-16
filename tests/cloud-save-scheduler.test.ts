import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaveScheduler } from '../src/lib/storage/save-scheduler';
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('cloud save coalescing', () => {
  it('debounces at 2s and caps continuous activity at 15s', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => true),
      scheduler = createSaveScheduler(task, { delayMs: 2000, maxWaitMs: 15000 });
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(1999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
    task.mockClear();
    scheduler.changed();
    for (let second = 0; second < 14; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      scheduler.changed();
    }
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
  it('keeps the local 500ms debounce, with no maximum timer overflow', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => true),
      scheduler = createSaveScheduler(task, { delayMs: 500, maxWaitMs: 0 });
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(499);
    expect(task).not.toHaveBeenCalled();
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(499);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
  it('serializes manual flushes and drains the latest edits before allowing navigation', async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>();
    let current = 1;
    const snapshots: number[] = [];
    const task = vi.fn(() => {
      snapshots.push(current);
      return snapshots.length === 1 ? pending.promise : Promise.resolve(true);
    });
    const scheduler = createSaveScheduler(task, { delayMs: 2000, maxWaitMs: 15000 });
    scheduler.changed();
    const first = scheduler.flush();
    current = 2;
    scheduler.changed();
    const second = scheduler.flush();
    expect(task).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(snapshots).toEqual([1, 2]);
    scheduler.dispose();
  });
  it('stops automatic retries after a failure, preserves pending edits, and retries only explicitly', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => false),
      scheduler = createSaveScheduler(task, { delayMs: 2000, maxWaitMs: 15000 });
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(2000);
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(60000);
    expect(task).toHaveBeenCalledTimes(1);
    task.mockResolvedValue(true);
    expect(await scheduler.flush()).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('allows a new local edit to retry after failure without an automatic retry loop', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => false);
    const scheduler = createSaveScheduler(task, { delayMs: 500, maxWaitMs: 0, retryOnChange: true });
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);
    task.mockResolvedValue(true);
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('discards scheduled callbacks on disposal and supports React StrictMode effect replay', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => true),
      scheduler = createSaveScheduler(task, { delayMs: 2000, maxWaitMs: 15000 });
    scheduler.changed();
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(30000);
    expect(task).not.toHaveBeenCalled();
    scheduler.start();
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});
