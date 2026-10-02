/**
 * `React.lazy`, plus a way to load the module before anything renders it — and, once it is
 * loaded, a first render that does not suspend at all.
 *
 * The second half is the point. A `React.lazy` component suspends on its first render even
 * when its module is already in memory: its initializer only starts on that render, and a
 * promise cannot report that it has settled until a microtask later. So the boundary commits
 * its spinner, and from then on react-dom holds the content back until 300 ms after that
 * spinner appeared (`FALLBACK_THROTTLE_MS`), however soon it is ready. Measured against
 * localhost on a desktop: a terminal's code had arrived 11–27 ms after the click, and the
 * terminal appeared at 350–355 ms. Loading the module sooner cannot change that; not
 * suspending does.
 */
import { lazy, useState, type ComponentType } from "react";

export type PreloadableComponent<P> = ComponentType<P> & {
  /** Load the module now. A load that fails is forgotten, so the next render asks again. */
  preload: () => Promise<void>;
};

export function lazyWithPreload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): PreloadableComponent<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<void> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (module) => { loaded = module.default; },
      (error: unknown) => { loading = undefined; throw error; },
    ));
  // What an instance mounted before the module arrived renders: it suspends, as `lazy` always did.
  const Lazy = lazy(() => preload().then(() => ({ default: loaded! })));

  function Preloadable(props: P) {
    // Chosen once per instance. A transition that suspends here and is pinged before it
    // resumes commits this instance as `Lazy` without rendering it again, so switching to the
    // loaded component on a later render would change the element type under it — and React
    // would remount the whole tab.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return Object.assign(Preloadable, { preload });
}
