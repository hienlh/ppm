import { describe, it, expect } from "bun:test";
import { ListRowInteractive } from "../../../src/web/components/os-explorer/views/list-row.tsx";
import { IconsViewTileInteractive } from "../../../src/web/components/os-explorer/views/icons-view-tile.tsx";
import { ColumnRowInteractive } from "../../../src/web/components/os-explorer/views/column-view-column.tsx";

/**
 * Regression guard for the row-context-menu bug: `ContextMenuTrigger asChild` clones its
 * child and merges its own `onContextMenu` handler (the one that actually opens the row's
 * menu) plus a `ref` onto it. `React.cloneElement` only reaches a plain function
 * component's *props* — a component that isn't `forwardRef` (so it can accept that `ref`)
 * silently drops both, and the row's own local handler runs but Radix's never does, so no
 * menu opens. This happened identically in List, Icons and Column view when each row's
 * interactive element was split out for the mobile tap branch.
 *
 * `forwardRef(...)` objects carry a stable `$$typeof` tag — checking for it here means any
 * future refactor that turns one of these back into a plain function component (the exact
 * regression) fails this test immediately, without needing a full DOM/Radix render harness
 * (which this test suite does not have).
 */
const FORWARD_REF_TYPE = Symbol.for("react.forward_ref");

describe("row/tile/column interactive components forward a ref (Radix asChild contract)", () => {
  it("ListRowInteractive is a forwardRef component", () => {
    expect((ListRowInteractive as unknown as { $$typeof: symbol }).$$typeof).toBe(FORWARD_REF_TYPE);
  });

  it("IconsViewTileInteractive is a forwardRef component", () => {
    expect((IconsViewTileInteractive as unknown as { $$typeof: symbol }).$$typeof).toBe(FORWARD_REF_TYPE);
  });

  it("ColumnRowInteractive is a forwardRef component", () => {
    expect((ColumnRowInteractive as unknown as { $$typeof: symbol }).$$typeof).toBe(FORWARD_REF_TYPE);
  });
});

// A behavioural test (mount the component, dispatch a real contextmenu event, assert the
// Radix menu opens) would be the stronger regression guard, but this suite has no DOM/React
// renderer configured (no jsdom/happy-dom, no @testing-library/react) — calling a
// forwardRef's `.render` directly outside React's own render cycle throws "Invalid hook
// call" the moment it reaches `useCoarseLongPress`/`useMobileRowTap`, since there is no
// active dispatcher. The full behavioural check lives in the live browser verification
// (see the report) instead.
