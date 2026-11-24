/**
 * `browser_*` on `/api/tab-tools-mcp`: an AI chat drives PPM's own browser.
 *
 * Chosen over handing the AI a raw CDP endpoint (Playwright `connectOverCDP`): every call here is
 * one of a few actions PPM performs itself, so the egress guard still applies, cookies and storage
 * cannot be read, no script of the AI's runs, and the person sees each action in the window and
 * can take the browser back. The user's own Playwright MCP (their CocCoc profile) is never
 * involved. A chat's first call asks the user on a card; "for this chat" is remembered until PPM
 * restarts.
 */
import { imageBlock, textResult, type Json } from "../mcp-http-endpoint.ts";
import { webBrowserHost } from "../web-browser/browser-host.ts";
import { viewerHub } from "../web-browser/viewer-hub.ts";
import { aiControlLock } from "../web-browser/ai-control/ai-control-lock.ts";
import { AiBrowserError, createAiBrowserActions } from "../web-browser/ai-control/ai-browser-actions.ts";
import { browserToolsUnavailable } from "../web-browser/browser-tools-availability.ts";
import { collabApprovalBroker } from "../session-collab/collab-approval-broker.ts";
import type { BrowserTool } from "../../shared/web-browser-tools.ts";

export { BROWSER_TOOLS, isBrowserTool } from "../../shared/web-browser-tools.ts";
export { BROWSER_TOOL_DEFINITIONS } from "./browser-tool-definitions.ts";
export { browserToolsUnavailable };

const str = (v: unknown, max = 8192): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);


const actions = createAiBrowserActions(webBrowserHost, viewerHub);

/** Asks the user once per chat; true when this call may go ahead. */
async function allowed(sessionId: string, url: string | null, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  if (aiControlLock.isGranted(sessionId)) return { ok: true };
  const outcome = await collabApprovalBroker.request(sessionId, { kind: "browser", url }, signal);
  if (!outcome.allowed) return { ok: false, message: outcome.message };
  if (outcome.answer === "allow_session") aiControlLock.grant(sessionId);
  return { ok: true };
}

export async function callBrowserTool(sessionId: string, sessionTitle: string | null, name: string, args: Json, signal?: AbortSignal): Promise<Json> {
  const off = browserToolsUnavailable();
  if (off) return textResult(off, true);
  const url = name === "browser_open" ? str(args.url) ?? null : null;
  const ok = await allowed(sessionId, url, signal);
  if (!ok.ok) return textResult(ok.message, true);
  if (!aiControlLock.begin(sessionId, sessionTitle)) {
    return textResult("The user took the browser back, so nothing was done. Wait for them to hand it back, or ask them.", true);
  }
  webBrowserHost.touchAi();
  try {
    await webBrowserHost.ensureStarted();
    switch (name as BrowserTool) {
      case "browser_open": {
        if (!url) return textResult("`url` is required.", true);
        return textResult(await actions.open(url));
      }
      case "browser_snapshot": return textResult(await actions.snapshot());
      case "browser_screenshot": return { content: [imageBlock(await actions.screenshot())] };
      case "browser_click": {
        const ref = str(args.ref, 16);
        return ref ? textResult(await actions.click(ref)) : textResult("`ref` is required.", true);
      }
      case "browser_type": {
        const text = str(args.text, 64 * 1024);
        if (text === undefined) return textResult("`text` is required.", true);
        return textResult(await actions.type(text, str(args.ref, 16), args.submit === true));
      }
      case "browser_press": {
        const key = str(args.key, 32);
        return key ? textResult(await actions.press(key)) : textResult("`key` is required.", true);
      }
      case "browser_scroll": {
        const dy = typeof args.dy === "number" && Number.isFinite(args.dy) ? Math.max(-10_000, Math.min(10_000, args.dy)) : 600;
        return textResult(await actions.scroll(dy));
      }
      case "browser_back": return textResult(await actions.back());
      case "browser_wait": {
        const ms = typeof args.ms === "number" && Number.isFinite(args.ms) ? args.ms : 2000;
        return textResult(await actions.waitFor(str(args.text, 500), ms));
      }
      default: return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    const message = error instanceof AiBrowserError ? error.message : `The browser could not do that: ${(error as Error)?.message ?? error}`;
    return textResult(message, true);
  }
}
