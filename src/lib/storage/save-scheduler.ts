/** Serial, coalescing autosave. Failed attempts stop until an explicit flush/retry. */
export function createSaveScheduler(
  task: () => Promise<boolean>,
  options: { delayMs: number; maxWaitMs: number; retryOnChange?: boolean },
) {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | undefined;
  let requested = false;
  let failed = false;
  let disposed = false;
  function clearTimers() {
    clearTimeout(quiet);
    clearTimeout(maximum);
    quiet = maximum = undefined;
  }
  function schedule() {
    if (disposed || failed) return;
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      void execute(false);
    }, options.delayMs);
    if (options.maxWaitMs > 0)
      maximum ??= setTimeout(() => {
        void execute(false);
      }, options.maxWaitMs);
  }
  async function execute(drain: boolean): Promise<boolean> {
    clearTimers();
    if (disposed) return false;
    if (running) {
      const result = await running;
      return result && drain && requested ? execute(true) : result;
    }
    if (!requested) return !failed;
    const run = async () => {
      do {
        requested = false;
        let success = false;
        try {
          success = await task();
        } catch {
          /* task normally presents its own save error */
        }
        if (!success) {
          failed = true;
          requested = true;
          clearTimers();
          return false;
        }
      } while (drain && requested && !disposed);
      return true;
    };
    running = run();
    try {
      return await running;
    } finally {
      running = undefined;
      if (requested && !failed) schedule();
    }
  }
  return {
    start() {
      disposed = false;
      failed = false;
    },
    changed() {
      if (options.retryOnChange) failed = false;
      requested = true;
      schedule();
    },
    flush() {
      requested = true;
      failed = false;
      return execute(true);
    },
    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}
