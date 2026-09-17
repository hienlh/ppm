import { afterEach, beforeEach, expect, it } from "bun:test";
// `?real` so this suite always gets the class, never a stub. `mock.module` is process-wide and
// cannot be undone once other files have bound their copy, so a sibling that fakes the socket
// to test something built on it — `lsp-client.test.ts` does — would otherwise hand every case
// here a fake whenever it happened to load first, and they would all fail with no clue why.
import { WsClient } from "../../../src/web/lib/ws-client.ts?real";

let now = 0;
let nextTimer = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const listeners = new Set<() => void>();
const clients: WsClient[] = [];
const original = new Map<string, PropertyDescriptor | undefined>();
const realNow = Date.now;

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: unknown) { this.sent.push(data); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive() { this.onmessage?.({ data: '{"type":"ping"}' } as MessageEvent); }
  close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
}

function replace(name: string, value: unknown) {
  original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function advance(ms: number) {
  const until = now + ms;
  while (true) {
    const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    now = due[1].at;
    timers.delete(due[0]);
    due[1].callback();
  }
  now = until;
}

function create(options?: ConstructorParameters<typeof WsClient>[1]) {
  const client = new WsClient("ws://localhost/chat", options);
  clients.push(client);
  client.connect();
  return client;
}

beforeEach(() => {
  now = 0;
  nextTimer = 0;
  Socket.instances = [];
  Date.now = () => now;
  replace("WebSocket", Socket);
  replace("window", { location: { protocol: "http:", host: "localhost" } });
  replace("document", {
    visibilityState: "visible",
    addEventListener: (_name: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_name: string, fn: () => void) => listeners.delete(fn),
  });
  replace("setTimeout", (callback: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  replace("clearTimeout", (id: number) => timers.delete(id));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  timers.clear();
  listeners.clear();
  Date.now = realNow;
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  original.clear();
});

it("recovers a silently stalled OPEN socket without replaying already sent messages", () => {
  const states: boolean[] = [];
  const client = create({ idleTimeoutMs: 45_000, onConnectionChange: value => states.push(value) });
  const first = Socket.instances[0]!;
  first.open();
  client.send("one message");
  advance(45_000);
  expect(Socket.instances).toHaveLength(2);
  expect(first.readyState).toBe(Socket.CLOSED);
  Socket.instances[1]!.open();
  expect(Socket.instances[1]!.sent).not.toContain("one message");
  expect(states).toEqual([true, false, true]);
});

it("keeps a healthy connection alive when heartbeat messages arrive", () => {
  create({ idleTimeoutMs: 45_000 });
  Socket.instances[0]!.open();
  for (let i = 0; i < 8; i++) {
    advance(15_000);
    Socket.instances[0]!.receive();
  }
  expect(Socket.instances).toHaveLength(1);
});

it("recovers a stalled handshake and flushes queued sends exactly once", () => {
  const client = create({ idleTimeoutMs: 45_000 });
  client.send("queued");
  advance(45_000);
  expect(Socket.instances).toHaveLength(2);
  Socket.instances[1]!.open();
  expect(Socket.instances[1]!.sent.filter(message => message === "queued")).toHaveLength(1);
});

it("checks a stale OPEN socket on wake even before suspended timers run", () => {
  create({ idleTimeoutMs: 45_000 });
  Socket.instances[0]!.open();
  now = 60_000;
  for (const listener of listeners) listener();
  expect(Socket.instances).toHaveLength(2);
  expect(timers.size).toBe(1);
});

it("does not interrupt a healthy connecting handshake on visibility changes", () => {
  create({ idleTimeoutMs: 45_000 });
  for (const listener of listeners) listener();
  expect(Socket.instances).toHaveLength(1);
});

it("manual reconnect cancels an older scheduled reconnect", () => {
  const client = create({ idleTimeoutMs: 45_000 });
  Socket.instances[0]!.open();
  Socket.instances[0]!.close();
  client.connect();
  Socket.instances[1]!.open();
  advance(1_000);
  expect(Socket.instances).toHaveLength(2);
});

it("intentional disconnect cancels all recovery and visibility listeners", () => {
  const client = create({ idleTimeoutMs: 45_000 });
  Socket.instances[0]!.open();
  client.disconnect();
  advance(100_000);
  expect(timers.size).toBe(0);
  expect(listeners.size).toBe(0);
  expect(Socket.instances).toHaveLength(1);
});

it("leaves sockets without an idle timeout open when their protocol has no heartbeats", () => {
  create();
  Socket.instances[0]!.open();
  advance(100_000);
  expect(Socket.instances).toHaveLength(1);
});
