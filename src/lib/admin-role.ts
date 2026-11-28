/**
 * The administrator role the screens show, checked once per tab however many components ask
 * (docs/d1-efficiency-round3-results-20261128.md, A). UI only: every server request checks the role
 * again. One request at a time: every 30 seconds while the tab is visible, when the window takes the
 * focus or the tab becomes visible, and at once (dropping a check already under way) when
 * `sjn-admin-role-changed` says the role may have changed. The checks run while a component is
 * watching and stop when the last one goes; a component that comes later reads the last answer.
 */
type Answer = { userId: string; isAdmin: boolean };

const listeners = new Set<() => void>();
let answer: Answer | undefined;
let owner: string | undefined;
let watchers = 0;
let controller: AbortController | undefined;
let stop: (() => void) | undefined;

function publish(next: Answer) {
  answer = next;
  for (const listener of listeners) listener();
}

function check(userId: string, again = false) {
  if (controller && !again) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  void fetch('/api/d1/role', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-SJN-User-Id': userId },
    signal: current.signal,
  })
    .then(async (response) => {
      if (response.ok) return response.json();
      if (response.status === 401 || response.status === 403) return { isAdmin: false };
      throw new Error('권한 연결 확인 실패');
    })
    .then((value) => {
      if (!current.signal.aborted && owner === userId) publish({ userId, isAdmin: value.isAdmin === true });
    })
    .catch(() => {
      /* Keep the last answer through a passing connection failure; the API still authorizes every operation. */
    })
    .finally(() => {
      if (controller === current) controller = undefined;
    });
}

function start(userId: string) {
  owner = userId;
  const refresh = () => check(userId);
  const changed = () => check(userId, true);
  const visible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  refresh();
  const timer = window.setInterval(visible, 30_000);
  window.addEventListener('focus', refresh);
  window.addEventListener('sjn-admin-role-changed', changed);
  document.addEventListener('visibilitychange', visible);
  stop = () => {
    controller?.abort();
    controller = undefined;
    window.clearInterval(timer);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('sjn-admin-role-changed', changed);
    document.removeEventListener('visibilitychange', visible);
    owner = undefined;
    stop = undefined;
  };
}

/** A component starts watching this account's role; the returned function ends it. */
export function watchAdminRole(userId: string) {
  watchers++;
  if (owner !== userId) {
    stop?.();
    start(userId);
  }
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    watchers--;
    if (watchers === 0) stop?.();
  };
}

/** For useSyncExternalStore: a change of the last answer. */
export function subscribeAdminRole(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The last answer for this account (never another account's). */
export function isAdminFor(userId: string | undefined) {
  return !!userId && answer?.userId === userId && answer.isAdmin;
}
