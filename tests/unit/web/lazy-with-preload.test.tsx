/**
 * A tab's first open waited at least 300 ms behind a spinner even when its code had long
 * arrived: `React.lazy` suspends on its first render regardless, and react-dom then holds the
 * content until 300 ms after the spinner appeared. A component whose module is already loaded
 * has to render without suspending at all — `act` skips that throttle, so what is asserted
 * here is the cause: whether a fallback rendered.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
const { act, lazy, startTransition, Suspense, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { lazyWithPreload } = await import("../../../src/web/lib/lazy-with-preload");

afterAll(uninstallDom);

let fallbacks = 0;
function Fallback() {
  fallbacks++;
  return <i>loading</i>;
}

function Label({ label }: { label: string }) {
  return <b>{label}</b>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("lazyWithPreload", () => {
  it("renders a component whose module is already loaded without suspending", async () => {
    const Tab = lazyWithPreload(async () => ({ default: Label }));
    await Tab.preload();
    fallbacks = 0;
    const view = await mount(<Suspense fallback={<Fallback />}><Tab label="ready" /></Suspense>);
    try {
      expect(view.container.textContent).toBe("ready");
      expect(fallbacks).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it("is measured against what React.lazy does with a module it already has", async () => {
    // The harness can see the suspension this exists to avoid: the same settled module,
    // behind `lazy`, still renders the fallback once.
    const settled = Promise.resolve({ default: Label });
    await settled;
    const Plain = lazy(() => settled);
    fallbacks = 0;
    const view = await mount(<Suspense fallback={<Fallback />}><Plain label="late" /></Suspense>);
    try {
      expect(view.container.textContent).toBe("late");
      expect(fallbacks).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  it("suspends when rendered before its module arrives, as React.lazy does", async () => {
    const module = deferred<{ default: ComponentType<{ label: string }> }>();
    const Tab = lazyWithPreload(() => module.promise);
    const view = await mount(<Suspense fallback={<Fallback />}><Tab label="first" /></Suspense>);
    try {
      expect(view.container.textContent).toBe("loading");
      await act(async () => { module.resolve({ default: Label }); });
      expect(view.container.textContent).toBe("first");
    } finally {
      await view.unmount();
    }
  });

  it("keeps that instance when the module lands while a transition is rendering it", async () => {
    // A concurrent render that suspends and is pinged before it resumes replays only the
    // suspended fiber, not its parent: the tab commits as `Lazy`, and the next render of the
    // parent must not trade that for the loaded component. `act` flushes differently and
    // re-renders the parent, so this runs on React's own scheduler.
    let mounts = 0;
    function Counted({ label }: { label: string }) {
      useEffect(() => { mounts++; }, []);
      return <b>{label}</b>;
    }
    const Tab = lazyWithPreload(() => Promise.resolve().then(() => ({ default: Counted })));
    let show!: () => void;
    let setLabel!: (label: string) => void;
    function Host() {
      const [shown, setShown] = useState(false);
      const [label, set] = useState("first");
      show = () => startTransition(() => setShown(true));
      setLabel = set;
      return <Suspense fallback={<Fallback />}>{shown && <Tab label={label} />}</Suspense>;
    }

    const scopes = [globalThis, window] as unknown as Array<{ IS_REACT_ACT_ENVIRONMENT?: boolean }>;
    for (const scope of scopes) scope.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    try {
      root.render(<Host />);
      await settle();
      show();
      await settle();
      expect(container.textContent).toBe("first");
      setLabel("second");
      await settle();
      expect(container.textContent).toBe("second");
      expect(mounts).toBe(1);
    } finally {
      root.unmount();
      container.remove();
      for (const scope of scopes) scope.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("loads the module once, however many ask for it", async () => {
    let loads = 0;
    const Tab = lazyWithPreload(async () => { loads++; return { default: Label }; });
    await Promise.all([Tab.preload(), Tab.preload()]);
    const view = await mount(<Tab label="once" />);
    try {
      expect(view.container.textContent).toBe("once");
      expect(loads).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  it("asks again after a load that failed", async () => {
    let loads = 0;
    const Tab = lazyWithPreload(async () => {
      loads++;
      if (loads === 1) throw new Error("offline");
      return { default: Label };
    });
    await expect(Tab.preload()).rejects.toThrow("offline");
    await Tab.preload();
    fallbacks = 0;
    const view = await mount(<Suspense fallback={<Fallback />}><Tab label="back" /></Suspense>);
    try {
      expect(view.container.textContent).toBe("back");
      expect(loads).toBe(2);
      expect(fallbacks).toBe(0);
    } finally {
      await view.unmount();
    }
  });
});
