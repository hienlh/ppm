/**
 * The server's only way in for a viewer's message: anything that is not exactly one of the
 * shapes in `web-browser-protocol.ts`, within its size caps, comes back null and is dropped.
 * A socket is authenticated, but what it sends is still not trusted to be well formed.
 */
import {
  WEB_BROWSER_MESSAGE_LIMITS as L,
  type KeyModifiers,
  type PointerButton,
  type WebBrowserClientMessage,
} from "./web-browser-protocol.ts";

type Raw = Record<string, unknown>;

const BUTTONS: readonly PointerButton[] = ["left", "right", "middle", "none"];
const TOUCH_PHASES = ["start", "move", "end", "cancel"] as const;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}
function frac(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= -0.5 && v <= 1.5 ? v : null;
}
function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function modifiers(v: unknown): KeyModifiers {
  const m = v && typeof v === "object" ? (v as Raw) : {};
  return { alt: m.alt === true, ctrl: m.ctrl === true, meta: m.meta === true, shift: m.shift === true };
}

function parseFields(r: Raw): WebBrowserClientMessage | null {
  switch (r.type) {
    case "auth": {
      const nonce = str(r.nonce, L.id);
      return nonce ? { type: "auth", nonce } : null;
    }
    case "viewport": {
      const cssWidth = num(r.cssWidth, 100, 8192), cssHeight = num(r.cssHeight, 100, 8192), dpr = num(r.dpr, 0.5, 4);
      if (cssWidth === null || cssHeight === null || dpr === null) return null;
      return { type: "viewport", cssWidth: Math.round(cssWidth), cssHeight: Math.round(cssHeight), dpr, mobile: r.mobile === true };
    }
    case "visibility":
      return typeof r.visible === "boolean" ? { type: "visibility", visible: r.visible } : null;
    case "navigate": {
      const url = str(r.url, L.url);
      return url !== null ? { type: "navigate", url } : null;
    }
    case "back": case "forward": case "reload": case "stop": case "releaseAll":
    case "clipboard.copyRequest": case "takeover": case "ai.release": case "ai.return":
      return { type: r.type } as WebBrowserClientMessage;
    case "tab.open": {
      if (r.url === undefined) return { type: "tab.open" };
      const url = str(r.url, L.url);
      return url !== null ? { type: "tab.open", url } : null;
    }
    case "tab.close": case "tab.activate": {
      const tabId = str(r.tabId, L.id);
      return tabId ? { type: r.type, tabId } : null;
    }
    case "pointer": {
      const xFrac = frac(r.xFrac), yFrac = frac(r.yFrac);
      const button = BUTTONS.includes(r.button as PointerButton) ? (r.button as PointerButton) : null;
      const down = r.down === null || typeof r.down === "boolean" ? (r.down as boolean | null) : undefined;
      if (xFrac === null || yFrac === null || !button || down === undefined) return null;
      const clickCount = num(r.clickCount, 1, 3);
      return { type: "pointer", xFrac, yFrac, button, down, ...(clickCount ? { clickCount } : {}) };
    }
    case "wheel": {
      const xFrac = frac(r.xFrac), yFrac = frac(r.yFrac), dx = num(r.dx, -10000, 10000), dy = num(r.dy, -10000, 10000);
      if (xFrac === null || yFrac === null || dx === null || dy === null) return null;
      return { type: "wheel", xFrac, yFrac, dx, dy };
    }
    case "key": {
      const key = str(r.key, L.key), code = str(r.code, L.key), location = num(r.location, 0, 3);
      if (key === null || code === null || location === null || typeof r.down !== "boolean") return null;
      return { type: "key", down: r.down, key, code, location, modifiers: modifiers(r.modifiers), repeat: r.repeat === true };
    }
    case "text": {
      const text = str(r.text, L.text);
      return text ? { type: "text", text } : null;
    }
    case "compose": {
      const text = str(r.text, L.text), selStart = num(r.selStart, 0, L.text), selEnd = num(r.selEnd, 0, L.text);
      return text !== null && selStart !== null && selEnd !== null ? { type: "compose", text, selStart, selEnd } : null;
    }
    case "touch": {
      const phase = TOUCH_PHASES.find((p) => p === r.phase);
      if (!phase || !Array.isArray(r.points) || r.points.length > L.touchPoints) return null;
      const points = [];
      for (const p of r.points as Raw[]) {
        const id = num(p?.id, 0, 1e6), xFrac = frac(p?.xFrac), yFrac = frac(p?.yFrac);
        if (id === null || xFrac === null || yFrac === null) return null;
        points.push({ id, xFrac, yFrac });
      }
      return { type: "touch", phase, points };
    }
    case "frame.ack": {
      const seq = num(r.seq, 0, 2 ** 32);
      return seq !== null ? { type: "frame.ack", seq } : null;
    }
    case "clipboard.paste": {
      const text = str(r.text, L.paste);
      return text !== null ? { type: "clipboard.paste", text } : null;
    }
    case "dialog.answer": {
      const id = str(r.id, L.id);
      if (!id || typeof r.accept !== "boolean") return null;
      const text = r.text === undefined ? undefined : str(r.text, L.text);
      if (text === null) return null;
      return { type: "dialog.answer", id, accept: r.accept, ...(text !== undefined ? { text } : {}) };
    }
    case "file.choose": {
      const chooserId = str(r.chooserId, L.id);
      if (!chooserId || !Array.isArray(r.uploadIds) || r.uploadIds.length > L.uploads) return null;
      const uploadIds = r.uploadIds.map((u) => str(u, L.id));
      return uploadIds.every((u): u is string => !!u) ? { type: "file.choose", chooserId, uploadIds } : null;
    }
    case "file.cancel": {
      const chooserId = str(r.chooserId, L.id);
      return chooserId ? { type: "file.cancel", chooserId } : null;
    }
    default:
      return null;
  }
}

/** A viewer's JSON text as a message, or null. */
export function parseWebBrowserClientMessage(text: string): WebBrowserClientMessage | null {
  if (text.length > L.paste + 1024) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return parseFields(raw as Raw);
}
