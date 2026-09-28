/**
 * A spinning icon rotates a span, never the svg.
 *
 * Chrome does not composite animations on SVG elements, so `animate-spin` on an
 * `<svg>` recalculates style and repaints every frame: measured on a live tab, one
 * spinner cost ~22% of a core against nothing measurable for the same glyph inside
 * a spinning span. Every icon in the app is built by `fluentIcon`, so this is the
 * one place the rule can hold for all of them.
 *
 * The cases are the shapes that actually occur at the ~190 call sites: a bare
 * spin, a margin, an absolutely positioned spinner, and one sized only by its
 * parent. `render` is called directly, as in `product-icons.test.ts`, because
 * `fluentIcon` uses no hooks and this suite has no React renderer.
 */
import { describe, expect, it } from "bun:test";
import * as icons from "../../../src/web/lib/icons.ts";
import { splitSpinClasses } from "../../../src/web/lib/fluent-icon.tsx";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function renderIcon(name: string, props: Record<string, unknown> = {}): El {
  const Icon = (icons as unknown as Record<string, { render: (p: Record<string, unknown>, ref: unknown) => El }>)[name];
  return Icon.render(props, null);
}

function spinning(props: Record<string, unknown>) {
  const el = renderIcon("Loader2", props);
  expect(el.type).toBe("span");
  const svg = el.props.children as El;
  expect(svg.type).toBe("svg");
  return { box: String(el.props.className).split(" "), svg };
}

describe("a spinning icon", () => {
  it("rotates a wrapping span and leaves size and colour on the svg", () => {
    const { box, svg } = spinning({ className: "size-4 animate-spin text-primary" });
    expect(box).toEqual(["inline-flex", "animate-spin"]);
    expect(svg.props.className).toBe("size-4 text-primary");
    expect(svg.props["data-icon"]).toBe("Loader2");
  });

  it("puts a margin outside the rotating box, so the glyph spins on its own centre", () => {
    const { box, svg } = spinning({ className: "mr-2 size-4 animate-spin" });
    expect(box).toContain("mr-2");
    expect(svg.props.className).toBe("size-4");
  });

  it("keeps an absolutely positioned spinner where it was placed", () => {
    const { box, svg } = spinning({ className: "absolute right-2 top-1/2 -translate-y-1/2 size-4 text-text-subtle animate-spin" });
    expect(box).toEqual(["inline-flex", "absolute", "right-2", "top-1/2", "-translate-y-1/2", "animate-spin"]);
    expect(svg.props.className).toBe("size-4 text-text-subtle");
  });

  it("leaves the svg classless when only the spin was given, so a parent's size rule still reaches it", () => {
    // button.tsx sizes child icons with `[&_svg:not([class*='size-'])]:size-3`.
    const { svg } = spinning({ className: "animate-spin" });
    expect(svg.props.className).toBeUndefined();
  });

  it("recognises a spin behind a variant", () => {
    expect(splitSpinClasses("size-4 motion-safe:animate-spin md:mr-2")).toEqual({
      box: "inline-flex motion-safe:animate-spin md:mr-2",
      glyph: "size-4",
    });
  });
});

describe("an icon that does not spin", () => {
  it("is still a bare svg with its classes untouched", () => {
    const el = renderIcon("RefreshCw", { className: "size-3.5 mr-1 shrink-0" });
    expect(el.type).toBe("svg");
    expect(el.props.className).toBe("size-3.5 mr-1 shrink-0");
    expect(splitSpinClasses("size-3.5 mr-1")).toBeNull();
  });

  it("does not mistake another animation for the spin", () => {
    expect(splitSpinClasses("size-2 animate-pulse")).toBeNull();
  });
});
