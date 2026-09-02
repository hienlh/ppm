import { describe, it, expect } from "bun:test";
import {
  openMobileExplorer,
  useMobileExplorerOpenState,
} from "../../../src/web/components/os-explorer/use-explorer-open-state.ts";

/**
 * `MobileExplorerSheet` clears `selectMode` on every path change via a `useEffect` that
 * calls `setSelectMode(false)` — untestable directly since this suite has no DOM/React
 * renderer (see `explorer-row-forwards-context-menu-ref.test.ts`'s note). What is testable
 * without a renderer is the pure store contract that effect relies on: `setSelectMode` is a
 * plain setter (no guard tying it to any other field), and both `close()` and
 * `openMobileExplorer()` already reset `selectMode` to `false` independent of it — so leaving
 * Select mode on mid-session never survives a close/reopen even if a future edit dropped the
 * path-change effect.
 */
describe("useMobileExplorerOpenState — selectMode reset paths", () => {
  it("setSelectMode toggles the flag directly, as the path-change effect relies on", () => {
    useMobileExplorerOpenState.setState({ isOpen: true, selectMode: true });
    useMobileExplorerOpenState.getState().setSelectMode(false);
    expect(useMobileExplorerOpenState.getState().selectMode).toBe(false);
  });

  it("close() resets selectMode even if it was left on", () => {
    useMobileExplorerOpenState.setState({ isOpen: true, selectMode: true });
    useMobileExplorerOpenState.getState().close();
    const state = useMobileExplorerOpenState.getState();
    expect(state.isOpen).toBe(false);
    expect(state.selectMode).toBe(false);
  });

  it("openMobileExplorer() always lands with selectMode off, even from a selecting state", async () => {
    useMobileExplorerOpenState.setState({ isOpen: false, selectMode: true });
    await openMobileExplorer("/tmp/some-dir");
    expect(useMobileExplorerOpenState.getState().selectMode).toBe(false);
  });
});
