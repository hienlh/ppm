/** An in-memory duplex standing in for `powershell.exe`, so the session tests
 *  never spawn a real process. Tests push replies by hand or via `autoReply`. */
import type { PsChild } from "../../../../../src/services/system-metrics/powershell-session-bootstrap.ts";

export interface FakePsChild extends PsChild {
  /** Raw lines written to stdin, in order. */
  writes: string[];
  /** Decoded request scripts, in order. */
  scripts: string[];
  /** Ids of requests received, in order. */
  ids: string[];
  /** Emit raw text on stdout. */
  emit(text: string): void;
  /** Emit `body` followed by the end marker for `id`. */
  reply(id: string, body: string): void;
  /** Simulate the child dying. */
  die(code?: number): void;
  killed: boolean;
  flushes: number;
}

export interface FakePsChildOptions {
  /** When set, every request is answered immediately with this function's output. */
  autoReply?: (script: string, id: string) => string;
  pid?: number;
}

export function createFakePsChild(opts: FakePsChildOptions = {}): FakePsChild {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  let closed = false;

  const child: FakePsChild = {
    pid: opts.pid ?? 4242,
    writes: [],
    scripts: [],
    ids: [],
    killed: false,
    flushes: 0,
    stdout,
    stderr: null,
    exited,
    stdin: {
      write(data: string) {
        if (closed) throw new Error("EPIPE");
        child.writes.push(data);
        const sp = data.indexOf(" ");
        const id = data.slice(0, sp);
        const script = Buffer.from(data.slice(sp + 1).trim(), "base64").toString("utf16le");
        child.ids.push(id);
        child.scripts.push(script);
        if (opts.autoReply) child.reply(id, opts.autoReply(script, id));
      },
      flush() { child.flushes++; },
    },
    emit(text) {
      if (!closed) controller.enqueue(encoder.encode(text));
    },
    reply(id, body) {
      child.emit(`${body}${body.endsWith("\n") || body === "" ? "" : "\r\n"}__END_${id}__\r\n`);
    },
    die(code = 1) {
      if (closed) return;
      closed = true;
      try { controller.close(); } catch { /* already closed */ }
      resolveExit(code);
    },
    kill() {
      child.killed = true;
      child.die(0);
    },
  };
  return child;
}

/** A spawner that hands out a fresh fake per spawn and records them. */
export function createFakeSpawner(opts: FakePsChildOptions = {}) {
  const children: FakePsChild[] = [];
  const spawn = () => {
    const c = createFakePsChild({ ...opts, pid: 1000 + children.length });
    children.push(c);
    return c;
  };
  return { spawn, children };
}
