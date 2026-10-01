/**
 * The Services table's columns, and the three things about them that have to
 * agree: the header labels, each cell's visibility class, and the grid template
 * at every width.
 *
 * They agree only by construction — all three are derived from `SERVICE_COLUMNS`
 * — and the failure when they do not is silent: a column with a header and no
 * track does not error, it shifts every cell after it one place to the left, so
 * the number under "Memory" is the swap figure and nothing says so. Each row is
 * its own grid element, so the header cannot even borrow the rows' sizing.
 */
import { describe, test, expect } from "bun:test";
import {
  SERVICE_COLUMNS, SERVICE_ROW_GRID_CLASS, BREAKPOINT_ORDER,
  columnVisibilityClass, gridTemplateAt, serviceGridCssVars, visibleColumnsAt,
  type ColumnBreakpoint,
} from "../../../src/web/components/system/services/service-columns.ts";

describe("the column set", () => {
  test("is Mission Center's own, in its order", () => {
    expect(SERVICE_COLUMNS.map((c) => c.key)).toEqual([
      "name", "pid", "cpu", "ram", "swap", "disk", "gpu", "gpuMem",
    ]);
    expect(SERVICE_COLUMNS.map((c) => c.label)).toEqual([
      "Name", "PID", "CPU", "Memory", "Swap", "Drive", "GPU", "GPU Memory",
    ]);
  });

  test("exactly one column is flexible, and it is the name", () => {
    const flexible = SERVICE_COLUMNS.filter((c) => c.width === null);
    expect(flexible.map((c) => c.key)).toEqual(["name"]);
    // Everything else is a fixed pixel track: an `auto` track is sized by the
    // row it is in, and two rows would then not line up with each other.
    for (const c of SERVICE_COLUMNS) {
      if (c.key !== "name") expect(typeof c.width).toBe("number");
    }
  });

  test("the name is always present; nothing else claims the base width", () => {
    expect(visibleColumnsAt("base").map((c) => c.key)).toEqual(["name"]);
  });
});

describe("templates and visibility cannot drift apart", () => {
  test("every breakpoint's template has one track per visible column", () => {
    for (const bp of BREAKPOINT_ORDER) {
      const tracks = gridTemplateAt(bp).split(" ");
      expect(tracks.length).toBe(visibleColumnsAt(bp).length);
    }
  });

  test("a column is visible at its own breakpoint and every wider one", () => {
    for (const column of SERVICE_COLUMNS) {
      const from = BREAKPOINT_ORDER.indexOf(column.from);
      for (const [i, bp] of BREAKPOINT_ORDER.entries()) {
        expect(visibleColumnsAt(bp).includes(column)).toBe(i >= from);
      }
    }
  });

  test("the widest template is the whole set, in column order", () => {
    expect(visibleColumnsAt("@4xl").map((c) => c.key)).toEqual(SERVICE_COLUMNS.map((c) => c.key));
    expect(gridTemplateAt("@4xl").startsWith("minmax(0,1fr) ")).toBe(true);
  });

  test("a hidden column has no track to be hidden from", () => {
    // The cell is `display:none` below its breakpoint, which is what keeps the
    // remaining cells on the remaining tracks.
    for (const bp of BREAKPOINT_ORDER) {
      for (const column of SERVICE_COLUMNS) {
        const visible = visibleColumnsAt(bp).includes(column);
        const hiddenClass = columnVisibilityClass(column).startsWith("hidden");
        if (!visible) expect(hiddenClass).toBe(true);
      }
    }
  });
});

describe("the classes Tailwind has to be able to see", () => {
  test("every visibility class is a literal, not a built string", () => {
    // A class assembled at runtime emits no CSS rule at all and the column would
    // show at every width — the same silent failure as a missing colour token.
    const allowed = new Set(["", "hidden @2xl:block", "hidden @3xl:block", "hidden @4xl:block"]);
    for (const column of SERVICE_COLUMNS) {
      expect(allowed.has(columnVisibilityClass(column))).toBe(true);
    }
  });

  test("the grid class names exactly the variables the panel sets", () => {
    const vars = serviceGridCssVars() as Record<string, string>;
    const named = [...SERVICE_ROW_GRID_CLASS.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(named.sort()).toEqual(Object.keys(vars).sort());
    for (const [name, value] of Object.entries(vars)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      expect(named).toContain(name);
    }
  });

  test("each variable carries its own breakpoint's template", () => {
    const vars = serviceGridCssVars() as Record<string, string>;
    const byBreakpoint: Record<string, ColumnBreakpoint> = {
      "--svc-cols-base": "base",
      "--svc-cols-2xl": "@2xl",
      "--svc-cols-3xl": "@3xl",
      "--svc-cols-4xl": "@4xl",
    };
    for (const [name, bp] of Object.entries(byBreakpoint)) {
      expect(vars[name]).toBe(gridTemplateAt(bp));
    }
  });

  test("the container-query classes are the ones the panel's @container supports", () => {
    // `@2xl:` etc. are container queries; they do nothing without an ancestor
    // marked `@container`, which the panel root is.
    expect(SERVICE_ROW_GRID_CLASS).toContain("grid ");
    for (const bp of ["@2xl", "@3xl", "@4xl"]) {
      expect(SERVICE_ROW_GRID_CLASS).toContain(`${bp}:grid-cols-[`);
    }
  });
});
