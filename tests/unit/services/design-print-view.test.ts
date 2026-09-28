import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { printInjection } from "../../../src/services/design/preview/print-view.ts";

const scriptOf = (html: string): string => /<script data-ppm-print="1">([\s\S]*)<\/script>$/.exec(html)![1]!;

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

/** Runs the print script in a window of its own, with `print` replaced by `onPrint`. */
function boot(onPrint: (win: Window) => void): Window {
  const win = new Window({ url: "http://localhost/api/design-preview/content/t/deck/index.html" });
  open.push(win);
  win.document.write("<!doctype html><html><head></head><body><section class=\"slide\">One</section></body></html>");
  Object.defineProperty(win, "print", { value: () => onPrint(win), configurable: true });
  new Function("window", "document", "navigator", "setTimeout", scriptOf(printInjection("slides")))(win, win.document, win.navigator, win.setTimeout.bind(win));
  return win;
}

describe("printInjection", () => {
  it("prints a deck one slide per 1280x720 page and a page design with a margin", () => {
    const slides = printInjection("slides");
    expect(slides).toContain("@page{size:1280px 720px;margin:0}");
    expect(slides).toContain("section.slide,[data-slide]{break-after:page!important");
    expect(slides).toContain("@media print{#ppm-print-banner{display:none!important}}");
    const page = printInjection("page");
    expect(page).toContain("@page{margin:12mm}");
    expect(page).not.toContain("break-after:page");
  });

  it("cannot break out of its own <script> element", () => {
    const script = scriptOf(printInjection("page"));
    expect(script).not.toMatch(/<\/script|<!--|<script/i);
    expect(() => new Function(script)).not.toThrow();
  });

  it("calls print() after load and shows no banner when the dialog opened", async () => {
    let printed = 0;
    const win = boot((w) => { printed++; w.dispatchEvent(new w.Event("beforeprint")); });
    win.dispatchEvent(new win.Event("load"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(printed).toBe(1);
    expect(win.document.getElementById("ppm-print-banner")).toBeNull();
  });

  it("shows the Ctrl/Cmd+P banner when print() was refused, and its button prints", async () => {
    let printed = 0;
    const win = boot(() => { printed++; });
    win.dispatchEvent(new win.Event("load"));
    await new Promise((r) => setTimeout(r, 1500));
    const banner = win.document.getElementById("ppm-print-banner");
    expect(banner?.textContent).toMatch(/(Ctrl|Cmd)\+P/);
    (banner!.querySelector("button") as unknown as { click(): void }).click();
    expect(printed).toBe(2);
    win.dispatchEvent(new win.Event("beforeprint"));
    expect(win.document.getElementById("ppm-print-banner")).toBeNull();
  });
});
