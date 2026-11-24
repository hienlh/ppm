/**
 * Messages on `/ws/web-browser` between a viewer (window or phone tab) and PPM's browser host.
 *
 * Control messages are JSON text. Pictures and sound go server → client as binary messages
 * (`web-browser-binary-frames.ts`), because base64 inside JSON costs a third more bytes on
 * exactly the stream that decides whether the browser feels usable over a phone link.
 *
 * Pointer positions travel as fractions of the picture (`xFrac`, `yFrac`), the shape Remote
 * Desktop already uses, so the server alone turns them into page pixels at its current viewport.
 */

export type PointerButton = "left" | "right" | "middle" | "none";

export interface KeyModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type WebBrowserClientMessage =
  | { type: "auth"; nonce: string }
  | { type: "viewport"; cssWidth: number; cssHeight: number; dpr: number; mobile: boolean }
  | { type: "visibility"; visible: boolean }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "stop" }
  | { type: "tab.open"; url?: string }
  | { type: "tab.close"; tabId: string }
  | { type: "tab.activate"; tabId: string }
  | { type: "pointer"; xFrac: number; yFrac: number; button: PointerButton; down: boolean | null; clickCount?: number }
  | { type: "wheel"; xFrac: number; yFrac: number; dx: number; dy: number }
  | { type: "key"; down: boolean; key: string; code: string; location: number; modifiers: KeyModifiers; repeat: boolean }
  | { type: "text"; text: string }
  | { type: "compose"; text: string; selStart: number; selEnd: number }
  | { type: "touch"; phase: "start" | "move" | "end" | "cancel"; points: { id: number; xFrac: number; yFrac: number }[] }
  | { type: "releaseAll" }
  | { type: "frame.ack"; seq: number }
  | { type: "clipboard.paste"; text: string }
  | { type: "clipboard.copyRequest" }
  | { type: "dialog.answer"; id: string; accept: boolean; text?: string }
  | { type: "file.choose"; chooserId: string; uploadIds: string[] }
  | { type: "file.cancel"; chooserId: string }
  | { type: "takeover" }
  | { type: "ai.release" }
  | { type: "ai.return" };

export type WebBrowserClientMessageType = WebBrowserClientMessage["type"];

export interface WebBrowserTabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** Opened by an AI chat's browser tools. */
  ai: boolean;
}

export type WebBrowserState = "starting" | "running" | "stopping" | "stopped" | "crashed";

export type WebBrowserBlockReason =
  | "private-address"
  | "own-port"
  | "metadata"
  | "dns-failed"
  | "scheme"
  | "tab-limit"
  | "public-access";

export interface WebBrowserLimits {
  maxTabs: number;
  idleStopMinutes: number;
  fpsCap: number;
  audio: boolean;
}

export type WebBrowserServerMessage =
  | { type: "hello"; tabs: WebBrowserTabInfo[]; activeTabId: string | null; limits: WebBrowserLimits }
  | { type: "tabs"; list: WebBrowserTabInfo[]; activeTabId: string | null }
  | { type: "status"; state: WebBrowserState; ramMB: number | null; tabCount: number; idleStopAt: number | null; message?: string }
  | { type: "clipboard.copy"; text: string }
  | { type: "dialog"; id: string; kind: "alert" | "confirm" | "prompt" | "beforeunload"; origin: string; message: string; defaultText: string }
  | { type: "dialog.closed"; id: string }
  | { type: "fileChooser"; chooserId: string; multiple: boolean; accept: string }
  | { type: "download"; id: string; name: string; sizeBytes: number | null; receivedBytes: number; state: "progress" | "done" | "canceled" }
  | { type: "blocked"; url: string; reason: WebBrowserBlockReason }
  | { type: "controller"; isYou: boolean }
  | { type: "ai"; active: boolean; sessionTitle: string | null; heldByUser: boolean }
  | { type: "error"; code: string; message: string };

/** Size caps checked by the parser before anything reaches Chrome. */
export const WEB_BROWSER_MESSAGE_LIMITS = {
  url: 8192,
  text: 64 * 1024,
  paste: 1024 * 1024,
  key: 64,
  id: 128,
  touchPoints: 10,
  uploads: 32,
} as const;
