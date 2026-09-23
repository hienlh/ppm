/**
 * The picker's outline boxes, drawn inside the design frame.
 *
 * They live in a closed shadow root on a host appended to `<html>`, with `pointer-events:
 * none` and the highest z-index: never an event target, out of reach of page CSS, and never
 * part of the markup a picked element is described with. The host is re-attached if the
 * page's own script removes it. Shipped as source (`ppm.lib.createPickerOverlay`), so it
 * may only use what it is handed.
 */

export interface PickerOverlay {
  host: HTMLElement;
  /** Place the dashed (`outline`) or solid (`selection`) box over `el`, or hide it. */
  show(which: "outline" | "selection", el: Element | null): void;
}

export function createPickerOverlay(doc: Document): PickerOverlay {
  const host = doc.createElement("ppm-design-overlay");
  host.setAttribute("aria-hidden", "true");
  const props: Array<[string, string]> = [
    ["position", "fixed"], ["top", "0"], ["left", "0"], ["width", "0"], ["height", "0"], ["display", "block"],
    ["overflow", "visible"], ["pointer-events", "none"], ["z-index", "2147483647"], ["margin", "0"], ["padding", "0"],
  ];
  for (const [name, value] of props) host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const box = (border: string, fill: string): HTMLElement => {
    const el = doc.createElement("div");
    el.style.cssText = "position:fixed;display:none;box-sizing:border-box;pointer-events:none;border-radius:2px;"
      + "border:" + border + ";background:" + fill + ";";
    root.appendChild(el);
    return el;
  };
  const boxes = {
    outline: box("2px dashed #2563eb", "rgba(37,99,235,0.08)"),
    selection: box("2px solid #2563eb", "rgba(37,99,235,0.14)"),
  };
  return {
    host,
    show(which, el) {
      if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host);
      const b = boxes[which];
      if (!el || !el.isConnected) {
        b.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      b.style.left = r.left + "px";
      b.style.top = r.top + "px";
      b.style.width = Math.max(2, r.width) + "px";
      b.style.height = Math.max(2, r.height) + "px";
      b.style.display = "block";
    },
  };
}
