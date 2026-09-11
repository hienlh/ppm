/**
 * The framing is the one place where being slightly wrong corrupts the whole
 * session rather than one request, so the split and multi-byte cases carry
 * their weight here.
 */
import { describe, it, expect } from "bun:test";
import {
  LspMessageDecoder,
  MAX_MESSAGE_BYTES,
  encodeMessage,
} from "../../../../src/services/lsp/lsp-protocol.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

/** Frame a payload the way a server would. */
function frame(json: string): Uint8Array {
  const body = bytes(json);
  return new Uint8Array([...bytes(`Content-Length: ${body.length}\r\n\r\n`), ...body]);
}

describe("encodeMessage", () => {
  it("writes a header whose length matches the body", () => {
    const out = new TextDecoder().decode(encodeMessage({ jsonrpc: "2.0", id: 1 }));
    const [header, body] = out.split("\r\n\r\n");

    expect(header).toBe(`Content-Length: ${bytes(body!).length}`);
    expect(JSON.parse(body!)).toEqual({ jsonrpc: "2.0", id: 1 });
  });

  it("counts bytes, not characters", () => {
    // "Chào" is 5 bytes and 4 characters. A character count here would make
    // every server read one byte short for the rest of the session.
    const out = encodeMessage({ m: "Chào" });
    const text = new TextDecoder().decode(out);
    const declared = Number(/Content-Length: (\d+)/.exec(text)![1]);

    const bodyBytes = out.length - bytes(text.split("\r\n\r\n")[0]! + "\r\n\r\n").length;
    expect(declared).toBe(bodyBytes);
    expect(declared).toBeGreaterThan(JSON.stringify({ m: "Chào" }).length);
  });
});

describe("LspMessageDecoder", () => {
  it("reads one whole message", () => {
    const out = new LspMessageDecoder().push(frame('{"jsonrpc":"2.0","id":1,"result":null}'));

    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: null }]);
  });

  it("reads several messages packed into one chunk", () => {
    const chunk = new Uint8Array([
      ...frame('{"id":1}'), ...frame('{"id":2}'), ...frame('{"id":3}'),
    ]);

    expect(new LspMessageDecoder().push(chunk).map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("waits for a body split across chunks", () => {
    const decoder = new LspMessageDecoder();
    const full = frame('{"id":7,"method":"textDocument/hover"}');

    expect(decoder.push(full.subarray(0, 30))).toEqual([]);
    expect(decoder.push(full.subarray(30)).map((m) => m.id)).toEqual([7]);
  });

  it("waits for a header split mid-way", () => {
    const decoder = new LspMessageDecoder();
    const full = frame('{"id":8}');

    // Split inside "Content-Length", before the value is even readable.
    expect(decoder.push(full.subarray(0, 7))).toEqual([]);
    expect(decoder.push(full.subarray(7, 12))).toEqual([]);
    expect(decoder.push(full.subarray(12)).map((m) => m.id)).toEqual([8]);
  });

  it("splits a chunk one byte at a time without losing anything", () => {
    const decoder = new LspMessageDecoder();
    const full = new Uint8Array([...frame('{"id":1}'), ...frame('{"id":2}')]);
    const seen: unknown[] = [];

    for (const byte of full) seen.push(...decoder.push(new Uint8Array([byte])));

    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("keeps a multi-byte payload intact", () => {
    // The regression this whole byte-level design exists for: 4 characters,
    // 5 bytes. A character-counting decoder truncates the JSON here.
    const decoder = new LspMessageDecoder();
    const message = { contents: "Chào — “smart quotes” 🎉", id: 4 };

    const out = decoder.push(encodeMessage(message));

    expect(out).toEqual([message]);
  });

  it("stays aligned after a multi-byte message", () => {
    const decoder = new LspMessageDecoder();
    const chunk = new Uint8Array([
      ...encodeMessage({ id: 1, text: "Chào bạn 🎉" }),
      ...encodeMessage({ id: 2, text: "plain" }),
    ]);

    expect(decoder.push(chunk).map((m) => m.id)).toEqual([1, 2]);
  });

  it("accepts a header name in any casing", () => {
    const body = bytes('{"id":9}');
    const chunk = new Uint8Array([...bytes(`content-length: ${body.length}\r\n\r\n`), ...body]);

    expect(new LspMessageDecoder().push(chunk).map((m) => m.id)).toEqual([9]);
  });

  it("ignores the extra headers some servers send", () => {
    const body = bytes('{"id":10}');
    const chunk = new Uint8Array([
      ...bytes(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`),
      ...body,
    ]);

    expect(new LspMessageDecoder().push(chunk).map((m) => m.id)).toEqual([10]);
  });

  it("drops one unparseable body but stays aligned for the next message", () => {
    const decoder = new LspMessageDecoder();
    const chunk = new Uint8Array([...frame("{not json"), ...frame('{"id":11}')]);

    // The framing was honest, so the stream is still aligned; only the bad
    // message is lost.
    expect(decoder.push(chunk).map((m) => m.id)).toEqual([11]);
  });

  it("throws on output that is not framing at all", () => {
    // A crash trace on stdout desynchronises the stream for good, so the
    // session has to be restarted rather than quietly losing input.
    const decoder = new LspMessageDecoder();

    expect(() => decoder.push(bytes("panic: runtime error\r\n\r\nstack trace here")))
      .toThrow(/no Content-Length/);
  });

  it("refuses a Content-Length that is not a number", () => {
    expect(() => new LspMessageDecoder().push(bytes("Content-Length: abc\r\n\r\n{}")))
      .toThrow(/Invalid Content-Length/);
  });

  it("gives up once stray output exceeds any plausible header block", () => {
    // A server writing a panic trace to stdout has no separator to find, so
    // without this bound the decoder buffers it forever and the session looks
    // healthy while serving nothing.
    const decoder = new LspMessageDecoder();
    const trace = "goroutine 1 [running]:\n".repeat(400);

    expect(() => decoder.push(bytes(trace))).toThrow(/not speaking the protocol/);
  });

  it("still waits when the header block is merely slow to arrive", () => {
    // The bound must not fire on a legitimate header split across chunks.
    const decoder = new LspMessageDecoder();

    expect(decoder.push(bytes("Content-Length: 9\r\n"))).toEqual([]);
    expect(decoder.push(bytes("\r\n"))).toEqual([]);
    expect(decoder.push(bytes('{"id":12}'))).toEqual([{ id: 12 }]);
  });

  it("refuses an absurd Content-Length instead of buffering forever", () => {
    expect(() => new LspMessageDecoder().push(bytes(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`)))
      .toThrow(/exceeds the/);
  });

  it("round-trips whatever the encoder produced", () => {
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: "file:///tmp/a b" } },
      { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { diagnostics: [] } },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } },
    ];
    const decoder = new LspMessageDecoder();
    const wire = messages.map(encodeMessage);
    const joined = new Uint8Array(wire.reduce<number[]>((acc, w) => [...acc, ...w], []));

    expect(decoder.push(joined)).toEqual(messages);
  });
});
