/**
 * A language server that exists only to be talked to.
 *
 * The framing is written out longhand rather than imported from
 * `src/services/lsp/lsp-protocol.ts` on purpose: a fixture that shares the
 * implementation under test agrees with it by construction, including about
 * anything both get wrong.
 *
 * `FAKE_LSP_MODE` picks the failure being reproduced:
 *   normal   answer everything (default)
 *   hang     complete the handshake, then never answer a request
 *   crash    exit non-zero right after initialize
 *   garbage  write unframed text to stdout
 *   needs-config  ask workspace/configuration before answering anything
 */
const MODE = process.env.FAKE_LSP_MODE ?? "normal";

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

let configAnswered = false;
const held: Array<Parameters<typeof handle>[0]> = [];
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  for (;;) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("latin1");
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? -1);
    if (length < 0) return;
    if (buffer.length < separator + 4 + length) return;

    const body = buffer.subarray(separator + 4, separator + 4 + length).toString("utf8");
    buffer = buffer.subarray(separator + 4 + length);
    handle(JSON.parse(body));
  }
});

function handle(message: { id?: number; method?: string; params?: unknown; result?: unknown }): void {
  const { id, method } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: { hoverProvider: true, completionProvider: { triggerCharacters: ["."] } },
        serverInfo: { name: "fake-language-server", version: "0.0.1" },
      },
    });
    if (MODE === "crash") {
      // After the handshake, so the test exercises a crash of a live session
      // rather than a failure to start.
      setTimeout(() => process.exit(3), 20);
    }
    if (MODE === "garbage") {
      // A real panic trace, not one line: a single stray line is legally
      // indistinguishable from an unknown header, so the decoder can only
      // reject output once it exceeds any plausible header block.
      setTimeout(() => {
        process.stdout.write("panic: runtime error: invalid memory address\n\n");
        process.stdout.write("goroutine 1 [running]:\n");
        for (let i = 0; i < 120; i++) {
          process.stdout.write(`\tgithub.com/example/pkg.function${i}(0xc0000b4000, 0x1, 0x2)\n`);
          process.stdout.write(`\t\t/home/build/go/src/github.com/example/pkg/file${i}.go:${100 + i} +0x1a4\n`);
        }
      }, 20);
    }
    return;
  }

  if (method === "initialized") {
    if (MODE === "needs-config") {
      // A real server does this and will not serve requests until it is
      // answered; the session has to reply unprompted.
      send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
    }
    send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "fake server ready" } });
    return;
  }

  // The session's answer to our configuration request comes back as a response.
  if (id === 9001 && method === undefined) {
    configAnswered = true;
    for (const queued of held.splice(0)) handle(queued);
    return;
  }

  // Until it is answered, hold everything. This is the real stall being
  // reproduced: tsserver will not serve one completion before it has its
  // configuration, so a client that never replies looks like a broken server.
  if (MODE === "needs-config" && !configAnswered && id != null) {
    held.push(message);
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }

  if (method === "exit") {
    process.exit(0);
  }

  if (method === "$/cancelRequest") return;

  if (id == null) return; // any other notification

  if (MODE === "hang") return; // the point of this mode

  if (method === "fake/echo") {
    send({ jsonrpc: "2.0", id, result: { echoed: message.params, configAnswered } });
    return;
  }

  if (method === "fake/unicode") {
    // Multi-byte on purpose: the byte-vs-character bug in Content-Length only
    // shows up on a payload like this.
    send({ jsonrpc: "2.0", id, result: { text: "Chào bạn — “quotes” 🎉", length: 21 } });
    return;
  }

  if (method === "fake/error") {
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params, as requested" } });
    return;
  }

  if (method === "fake/serverRequest") {
    // Ask the client something it does not handle itself, then report what it
    // said. A client that answers nothing here would leave us hanging.
    send({ jsonrpc: "2.0", id: 9100, method: "fake/askClient", params: { question: "are you there" } });
    send({ jsonrpc: "2.0", id, result: { asked: true } });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
