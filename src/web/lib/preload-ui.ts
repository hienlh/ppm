/**
 * Loads the code behind every tab and window while the app has nothing else to do, so the
 * first terminal, editor or chat of a session opens at once instead of behind a spinner.
 * `lazy-with-preload.tsx` is why a loaded module also has to skip that spinner.
 *
 * It is a download, so it is skipped wherever one costs the user something: a data-saver
 * setting, a 2G link, and any touch-only device not known to be on Wi-Fi — which includes
 * every iPhone, since Safari says nothing about its connection.
 */

/** The fields of `navigator.connection` (Network Information API) this reads. */
export interface ConnectionHints {
  saveData?: boolean;
  effectiveType?: string;
  type?: string;
}

export function shouldPreloadUi(connection: ConnectionHints | undefined, touchOnly: boolean): boolean {
  if (connection?.saveData) return false;
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return false;
  if (!touchOnly) return true;
  return connection?.type === "wifi" || connection?.type === "ethernet";
}

/** Runs `run` once the main thread is idle; returns a function that calls it off. */
export type WhenIdle = (run: () => void) => () => void;

const whenIdle: WhenIdle = (run) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run);
    return () => cancelIdleCallback(id);
  }
  // Safari has no `requestIdleCallback`.
  const id = setTimeout(run, 200);
  return () => clearTimeout(id);
};

/**
 * Runs `tasks` one after another, each starting in an idle period of its own, so no two
 * modules are evaluated in one stretch of the main thread. A task that fails is skipped:
 * whatever needed that module will ask for it again. Returns a function that stops the rest.
 */
export function preloadWhenIdle(tasks: ReadonlyArray<() => Promise<unknown>>, idle: WhenIdle = whenIdle): () => void {
  let stopped = false;
  let cancel = () => {};
  const next = (i: number) => {
    if (stopped || i >= tasks.length) return;
    cancel = idle(() => {
      void Promise.resolve()
        .then(tasks[i])
        .catch(() => {})
        .then(() => next(i + 1));
    });
  };
  next(0);
  return () => {
    stopped = true;
    cancel();
  };
}
