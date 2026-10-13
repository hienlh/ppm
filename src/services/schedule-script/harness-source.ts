/**
 * The whole program of the child process a script schedule runs in, started as
 * `[process.execPath, "--eval", HARNESS_SOURCE]` with `BUN_BE_BUN=1` — `bun` from source, the
 * compiled `ppm` acting as bun in a release (the way `db-driver-install.ts` runs its bundler).
 * It is a string because a compiled binary cannot spawn a file embedded in itself.
 *
 * It must leave no orphan behind, however PPM goes away (see this directory's CLAUDE.md):
 *  - PPM holds the child's stdin open and never writes to it. The read below ends when PPM
 *    dies, a SIGKILL included — Bun's IPC `disconnect` does not fire then.
 *  - A script that blocks this thread's event loop never reads that EOF, so a Worker checks
 *    every 250 ms that PPM is still the parent and SIGKILLs this process when it is not.
 *    It reads the parent from /proc/self/stat: `process.ppid` inside a Worker kept the dead
 *    parent's pid while the main thread was blocked. Elsewhere it asks whether that pid exists.
 *
 * Protocol (JSON over Bun IPC): child `ready` → PPM `init` → child `call`s answered by
 * `result`s, `hb` every 10 s, then `done` with the final state. PPM answers `done` by closing
 * stdin; `stop` aborts `ctx.signal`. Logging is plain stdout/stderr, which PPM reads by line.
 * Written with String.raw and without `${`: every backslash below reaches the child as typed.
 */
export const HARNESS_SOURCE = String.raw`
const PARENT = process.ppid;
const STOP_GRACE_MS = 3000;
const controller = new AbortController();
const pending = new Map();
let nextId = 1;
let state = {};
let finished = false;
let exitCode = 0;

function send(message) { try { process.send(message); } catch {} }
function describe(e) { return e instanceof Error ? (e.stack || e.message) : String(e); }
function abortError(reason) {
  const e = new Error(reason);
  e.name = "AbortError";
  return e;
}

function parentGone() {
  if (finished) process.exit(exitCode);
  controller.abort(abortError("PPM stopped"));
  setTimeout(() => process.exit(0), STOP_GRACE_MS);
}
(async () => {
  try { for await (const _ of Bun.stdin.stream()) {} } catch {}
  parentGone();
})();

function watchdogMain() {
  const fs = require("node:fs");
  self.onmessage = (event) => {
    const parent = event.data;
    const gone = () => {
      try {
        const stat = fs.readFileSync("/proc/self/stat", "utf8");
        return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== parent;
      } catch {}
      try { process.kill(parent, 0); return false; } catch (e) { return e.code === "ESRCH"; }
    };
    setInterval(() => { if (gone()) process.kill(process.pid, "SIGKILL"); }, 250);
    self.postMessage("up");
  };
}
async function startWatchdog() {
  const source = "(" + watchdogMain.toString() + ")()";
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/javascript" })));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    worker.onmessage = () => { clearTimeout(timer); resolve(); };
    worker.onerror = (e) => { clearTimeout(timer); console.error("PPM watchdog failed to start: " + (e.message || e)); resolve(); };
    worker.postMessage(PARENT);
  });
  worker.unref();
}

function call(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("ctx." + method + " timed out"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ t: "call", id, method, params });
  });
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const signal = controller.signal;
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function serializeState() {
  const json = JSON.stringify(state === undefined ? {} : state);
  if (json === undefined) throw new Error("ctx.state must be a JSON value");
  return json;
}

function makeCtx(init) {
  state = init.state && typeof init.state === "object" ? init.state : {};
  const opt = (o) => (o && typeof o === "object" ? o : {});
  return {
    schedule: init.schedule,
    project: init.project,
    inputs: Object.freeze(Object.assign({}, init.inputs)),
    get state() { return state; },
    set state(value) { state = value; },
    save: async () => call("save", { state: serializeState() }, 30000),
    log: (...args) => console.log(...args),
    notify: (n) => call("notify", n, 30000),
    signal: controller.signal,
    sleep,
    ai: {
      ask: (prompt, o) => call("ai.ask", { prompt, opts: opt(o) }, (opt(o).timeoutMs || 120000) + 15000),
      chat: (key, prompt, o) => call("ai.chat", { key, prompt, opts: opt(o) },
        opt(o).wait === false ? 30000 : (opt(o).timeoutMs || 1800000) + 60000),
      finished: () => call("ai.finished", {}, 30000),
    },
  };
}

function finish(error) {
  if (finished) return;
  finished = true;
  let snapshot = null;
  try { snapshot = serializeState(); } catch (e) { error = error || describe(e); }
  exitCode = error ? 1 : 0;
  send({ t: "done", state: snapshot, error });
  setTimeout(() => process.exit(exitCode), 2000);
}

async function run(init) {
  await startWatchdog();
  setInterval(() => send({ t: "hb" }), init.heartbeatMs || 10000);
  const ctx = makeCtx(init);
  let error = null;
  try {
    const mod = await import(init.scriptPath);
    if (typeof mod.default !== "function") {
      throw new Error("A schedule script must export a default function: export default async function (ctx) { ... }");
    }
    await mod.default(ctx);
  } catch (e) {
    error = describe(e);
  }
  finish(error);
}

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "init") run(m).catch((e) => finish(describe(e)));
  else if (m.t === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
  } else if (m.t === "stop") controller.abort(abortError(m.reason || "stopped"));
});
process.on("unhandledRejection", (e) => { console.error(describe(e)); finish(describe(e)); });
process.on("uncaughtException", (e) => { console.error(describe(e)); finish(describe(e)); });
send({ t: "ready" });
`;
