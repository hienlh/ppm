import { describe, expect, it } from "bun:test";
import { readNdjson } from "../../../src/web/lib/read-ndjson";

/** A body that arrives as these chunks, in this order. */
function body(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function values(chunks: (string | Uint8Array)[]): Promise<unknown[]> {
  const out: unknown[] = [];
  await readNdjson(body(chunks), (v) => out.push(v));
  return out;
}

describe("readNdjson", () => {
  it("hands over each line's value, whichever chunks the lines arrived in", async () => {
    expect(await values(['{"a":1}\n{"b"', ':2}\n', '{"c":3}\n{"d":4}\n'])).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  });

  it("hands each value over as its line ends, before the rest of the body has come", async () => {
    const seen: unknown[] = [];
    let send!: (text: string) => void;
    let finish!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (text) => controller.enqueue(new TextEncoder().encode(text));
        finish = () => controller.close();
      },
    });
    const reading = readNdjson(stream, (v) => seen.push(v));
    send('{"n":1}\n{"n":');
    await Bun.sleep(5);
    expect(seen).toEqual([{ n: 1 }]);
    send("2}\n");
    finish();
    await reading;
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("keeps a character whose bytes are split between two chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"Nguyễn 🐘"}\n');
    const cut = bytes.indexOf(0xf0) + 2;
    expect(await values([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([{ name: "Nguyễn 🐘" }]);
  });

  it("skips blank lines and reads a last line that has no newline", async () => {
    expect(await values(['\n{"a":1}\r\n', "\n  \n", '{"b":2}'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reads one long line arriving in many small chunks", async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => [i, `row ${i}`]);
    const text = `${JSON.stringify({ rows })}\n`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 512) chunks.push(text.slice(i, i + 512));
    const [only] = (await values(chunks)) as { rows: unknown[][] }[];
    expect(only!.rows.length).toBe(20_000);
    expect(only!.rows[19_999]).toEqual([19_999, "row 19999"]);
  });

  it("fails on a line that is not JSON, rather than skipping what it said", async () => {
    await expect(values(['{"a":1}\n', "not json\n"])).rejects.toThrow();
  });

  it("fails on a body that ends partway through a character, rather than dropping its last bytes", async () => {
    const seen: unknown[] = [];
    const half = new TextEncoder().encode("🐘").slice(0, 2);
    await expect(readNdjson(body(['{"a":1}\n', half]), (v) => seen.push(v))).rejects.toThrow();
    expect(seen).toEqual([{ a: 1 }]);
  });
});
