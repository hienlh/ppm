/**
 * The header line of the `browser_*` tools an AI chat drives PPM's web browser with
 * (`src/services/tab-tools-mcp/browser-tools.ts`), read from the call's arguments and answer.
 */
import { isBrowserTool } from "../../shared/web-browser-tools";
import { labelFor, oneLine, str, type PpmToolContext, type PpmToolSummary } from "./ppm-tool-summary-types";

/** `[ref=e12]` lines in a snapshot: how many things the AI can act on. */
const REF = /\[ref=e\d+\]/g;

export function browserToolSummary(ctx: PpmToolContext): PpmToolSummary | null {
  if (!isBrowserTool(ctx.tool)) return null;
  switch (ctx.tool) {
    case "browser_open": {
      const url = str(ctx.args.url);
      return { label: labelFor(ctx, "Open in browser", "Opened in browser"), detail: url ? oneLine(url, 60) : undefined };
    }
    case "browser_snapshot": {
      const refs = ctx.ok ? (ctx.text.match(REF) ?? []).length : 0;
      const page = ctx.ok ? /^Page: (.*?) — /.exec(ctx.text)?.[1] : undefined;
      return { label: labelFor(ctx, "Read the page", "Read the page"), detail: page ? oneLine(page, 60) : undefined, badge: ctx.ok ? `${refs} elements` : undefined };
    }
    case "browser_screenshot": return { label: labelFor(ctx, "Take a picture of the page", "Took a picture of the page") };
    case "browser_click": return { label: labelFor(ctx, "Click", "Clicked"), detail: str(ctx.args.ref) };
    case "browser_type": {
      const text = str(ctx.args.text);
      return { label: labelFor(ctx, "Type", "Typed"), detail: text ? `“${oneLine(text, 40)}”${ctx.args.submit === true ? " ↵" : ""}` : undefined };
    }
    case "browser_press": return { label: labelFor(ctx, "Press", "Pressed"), detail: str(ctx.args.key) };
    case "browser_scroll": return { label: labelFor(ctx, "Scroll", "Scrolled"), detail: typeof ctx.args.dy === "number" ? `${ctx.args.dy > 0 ? "down" : "up"} ${Math.abs(ctx.args.dy)} px` : undefined };
    case "browser_back": return { label: labelFor(ctx, "Go back", "Went back") };
    case "browser_wait": {
      const text = str(ctx.args.text);
      return { label: labelFor(ctx, "Wait", "Waited"), detail: text ? `for “${oneLine(text, 40)}”` : undefined };
    }
  }
}
