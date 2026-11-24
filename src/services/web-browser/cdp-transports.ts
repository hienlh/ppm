/**
 * The two ways bytes reach Chrome's DevTools endpoint (see `cdp-connection.ts` for which is used
 * where and why).
 *
 * Pipe: Chrome reads commands on fd 3 and writes replies on fd 4, each message ending in a NUL
 * byte. `NulFramer` reassembles messages that arrive split across chunks or several per chunk.
 *
 * WebSocket: to `ws://127.0.0.1:<port>/devtools/browser/<id>` as written in the profile's
 * `DevToolsActivePort`. The client sends no `Origin` header, which is what Chrome (since 111)
 * requires of a DevTools socket — a web page always sends one, so a page cannot reach this
 * endpoint even though it listens on loopback.
 */
import type { Readable, Writable } from "node:stream";
import type { CdpTransport } from "./cdp-connection.ts";

/** Splits a NUL-delimited byte stream into whole UTF-8 messages. */
export class NulFramer {
  private chunks: Buffer[] = [];

  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, i));
      out.push(Buffer.concat(this.chunks).toString("utf8"));
      this.chunks = [];
      start = i + 1;
    }
    if (start < chunk.length) this.chunks.push(Buffer.from(chunk.subarray(start)));
    return out;
  }
}

export function pipeTransport(toChrome: Writable, fromChrome: Readable): CdpTransport {
  const framer = new NulFramer();
  let onMessage: (m: string) => void = () => {};
  let closed = false;
  const closeCbs: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  fromChrome.on("data", (chunk: Buffer) => {
    for (const message of framer.push(chunk)) onMessage(message);
  });
  fromChrome.on("close", close);
  fromChrome.on("error", close);
  toChrome.on("error", close);
  return {
    send: (message) => { toChrome.write(`${message}\0`); },
    onMessage: (cb) => { onMessage = cb; },
    onClose: (cb) => { closeCbs.push(cb); },
    close: () => {
      try { toChrome.end(); } catch {}
      close();
    },
  };
}

/** Opens the DevTools WebSocket; rejects if it does not open within `timeoutMs`. */
export function webSocketTransport(url: string, timeoutMs = 5000): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let onMessage: (m: string) => void = () => {};
    const closeCbs: (() => void)[] = [];
    let open = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("DevTools socket did not open"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      open = true;
      clearTimeout(timer);
      resolve({
        send: (message) => ws.send(message),
        onMessage: (cb) => { onMessage = cb; },
        onClose: (cb) => { closeCbs.push(cb); },
        close: () => { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") onMessage(ev.data);
      else onMessage(Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
    });
    ws.addEventListener("close", () => {
      if (!open) {
        clearTimeout(timer);
        reject(new Error("DevTools socket closed before opening"));
      }
      for (const cb of closeCbs) cb();
    });
    ws.addEventListener("error", () => { /* close follows */ });
  });
}
