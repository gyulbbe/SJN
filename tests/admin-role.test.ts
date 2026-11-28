import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The administrator role the screens show (src/lib/admin-role.ts): one check per tab however many
 * components watch, none for a component that comes later, none while the tab is hidden, at once when
 * the role may have changed, never another account's answer.
 */
type Listener = () => void;
function target() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => void listeners.get(type)?.delete(listener),
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((listener) => listener()),
  };
}
let win: ReturnType<typeof target> & Record<string, unknown>;
let doc: ReturnType<typeof target> & { visibilityState: string };
let answers: { userId: string; isAdmin: boolean }[];
let calls: string[];
let role: typeof import('../src/lib/admin-role');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  win = Object.assign(target(), {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  doc = Object.assign(target(), { visibilityState: 'visible' });
  answers = [];
  calls = [];
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const userId = (init.headers as Record<string, string>)['X-SJN-User-Id'];
      calls.push(userId);
      const admin = answers.find((a) => a.userId === userId)?.isAdmin ?? false;
      return new Response(JSON.stringify({ isAdmin: admin }), { status: 200 });
    }),
  );
  role = await import('../src/lib/admin-role');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('역할 확인은 탭당 하나', () => {
  it('watchers share one check, every 30 seconds while visible; a later watcher reads the answer', async () => {
    answers.push({ userId: 'u1', isAdmin: true });
    const leave = [role.watchAdminRole('u1'), role.watchAdminRole('u1'), role.watchAdminRole('u1')];
    await settle();
    expect(calls).toEqual(['u1']);
    expect(role.isAdminFor('u1')).toBe(true);
    // A dialog that opens later: no request.
    const dialog = role.watchAdminRole('u1');
    await settle();
    expect(calls).toHaveLength(1);
    dialog();
    // Five minutes visible: one check every 30 seconds.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(11);
    // Hidden: none.
    doc.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toHaveLength(11);
    // Shown again and focused at once: the second waits for the first.
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    win.fire('focus');
    await settle();
    expect(calls).toHaveLength(12);
    leave.forEach((end) => end());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(12);
  });

  it('a possible role change checks at once, even while a check is under way', async () => {
    answers.push({ userId: 'u1', isAdmin: true });
    const end = role.watchAdminRole('u1');
    // The role is taken away while the first check is under way: its answer must not win.
    answers[0].isAdmin = false;
    win.fire('sjn-admin-role-changed');
    await settle();
    expect(calls).toEqual(['u1', 'u1']);
    expect(role.isAdminFor('u1')).toBe(false);
    end();
  });

  it('never answers for another account, and starts over for the new one', async () => {
    answers.push({ userId: 'u1', isAdmin: true }, { userId: 'u2', isAdmin: false });
    const first = role.watchAdminRole('u1');
    await settle();
    expect(role.isAdminFor('u1')).toBe(true);
    first();
    const second = role.watchAdminRole('u2');
    expect(role.isAdminFor('u2')).toBe(false);
    await settle();
    expect(calls).toEqual(['u1', 'u2']);
    expect(role.isAdminFor('u2')).toBe(false);
    expect(role.isAdminFor(undefined)).toBe(false);
    second();
  });

  it('keeps the last answer through a failed check, and tells watchers when it changes', async () => {
    answers.push({ userId: 'u1', isAdmin: true });
    const heard = vi.fn();
    const unsubscribe = role.subscribeAdminRole(heard);
    const end = role.watchAdminRole('u1');
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(role.isAdminFor('u1')).toBe(true);
    unsubscribe();
    end();
  });
});
