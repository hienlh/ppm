/**
 * Viewer input → CDP `Input.*` commands for one page session.
 *
 * Typed characters arrive as `text` (and `compose` while an IME is still composing — Vietnamese
 * Telex on a phone keyboard, Unikey on a PC) and go in with `Input.insertText` /
 * `Input.imeSetComposition`, never as key codes: a key code says which key was pressed, not
 * which letter the IME produced. `key` carries only what has no character — Enter, Backspace,
 * arrows, shortcuts — with the Windows virtual-key code Chrome needs to act on it.
 */
import type { CdpConnection } from "./cdp-connection.ts";
import { codeToVk } from "../remote-desktop/remote-desktop-vk-map.ts";
import type { KeyModifiers, PointerButton, WebBrowserClientMessage } from "../../shared/web-browser-protocol.ts";

export interface Viewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  mobile: boolean;
}

const BUTTON_BIT: Record<PointerButton, number> = { left: 1, right: 2, middle: 4, none: 0 };

export function modifierBits(m: KeyModifiers): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

/** Text Chrome should insert for a key, when the key alone produces one. */
function keyText(key: string, m: KeyModifiers): string | undefined {
  if (key === "Enter") return "\r";
  if (key.length === 1 && !m.ctrl && !m.meta && !m.alt) return key;
  return undefined;
}

export type CdpCall = { method: string; params: Record<string, unknown> };

/** Pure: the CDP calls one message becomes. `held` tracks pressed buttons across calls. */
export function inputToCdp(
  msg: WebBrowserClientMessage,
  vp: Viewport,
  held: { buttons: number; keys: Map<string, { key: string; vk: number }> },
): CdpCall[] {
  const x = (f: number) => Math.round(Math.min(1, Math.max(0, f)) * vp.cssWidth);
  const y = (f: number) => Math.round(Math.min(1, Math.max(0, f)) * vp.cssHeight);
  switch (msg.type) {
    case "pointer": {
      const bit = BUTTON_BIT[msg.button];
      if (msg.down === true) held.buttons |= bit;
      const type = msg.down === null ? "mouseMoved" : msg.down ? "mousePressed" : "mouseReleased";
      const params = { type, x: x(msg.xFrac), y: y(msg.yFrac), button: msg.down === null ? "none" : msg.button, buttons: held.buttons, clickCount: msg.down === null ? 0 : (msg.clickCount ?? 1) };
      if (msg.down === false) held.buttons &= ~bit;
      return [{ method: "Input.dispatchMouseEvent", params }];
    }
    case "wheel":
      return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: x(msg.xFrac), y: y(msg.yFrac), deltaX: msg.dx, deltaY: msg.dy } }];
    case "key": {
      const vk = codeToVk(msg.code) ?? 0;
      const modifiers = modifierBits(msg.modifiers);
      if (!msg.down) {
        held.keys.delete(msg.code);
        return [{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: msg.key, code: msg.code, windowsVirtualKeyCode: vk, modifiers, location: msg.location } }];
      }
      held.keys.set(msg.code, { key: msg.key, vk });
      const text = keyText(msg.key, msg.modifiers);
      return [{
        method: "Input.dispatchKeyEvent",
        params: { type: text ? "keyDown" : "rawKeyDown", key: msg.key, code: msg.code, windowsVirtualKeyCode: vk, modifiers, location: msg.location, autoRepeat: msg.repeat, ...(text ? { text, unmodifiedText: text } : {}) },
      }];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: msg.text } }];
    case "compose":
      return [{ method: "Input.imeSetComposition", params: { text: msg.text, selectionStart: msg.selStart, selectionEnd: msg.selEnd } }];
    case "touch": {
      const touchPoints = msg.points.map((p) => ({ x: x(p.xFrac), y: y(p.yFrac), id: p.id }));
      if (msg.phase === "cancel") return [{ method: "Input.dispatchTouchEvent", params: { type: "touchCancel", touchPoints: [] } }];
      if (msg.phase === "end") {
        return [{ method: "Input.dispatchTouchEvent", params: touchPoints.length ? { type: "touchMove", touchPoints } : { type: "touchEnd", touchPoints: [] } }];
      }
      return [{ method: "Input.dispatchTouchEvent", params: { type: msg.phase === "start" ? "touchStart" : "touchMove", touchPoints } }];
    }
    case "releaseAll": {
      const calls: CdpCall[] = [];
      for (const [code, k] of held.keys) {
        calls.push({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: k.key, code, windowsVirtualKeyCode: k.vk } });
      }
      held.keys.clear();
      if (held.buttons) {
        calls.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0, clickCount: 1 } });
        held.buttons = 0;
      }
      return calls;
    }
    default:
      return [];
  }
}

/** Sends one viewer message's input to the page; errors from a closing page are ignored. */
export class InputBridge {
  private readonly held = { buttons: 0, keys: new Map<string, { key: string; vk: number }>() };

  constructor(private readonly cdp: CdpConnection) {}

  async send(msg: WebBrowserClientMessage, vp: Viewport, sessionId: string): Promise<void> {
    for (const call of inputToCdp(msg, vp, this.held)) {
      await this.cdp.send(call.method, call.params, sessionId).catch(() => {});
    }
  }
}
