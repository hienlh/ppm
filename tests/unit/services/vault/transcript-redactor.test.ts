/**
 * Rewriting a provider's history file after a turn handed out vault values: only lines holding a
 * value change, each stays one valid JSON record with its links (`parentUuid`, `uuid`) intact,
 * every other byte is kept, and a file that moves while being rewritten is left for a retry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTranscriptRedactor, redactJsonlFile } from "../../../../src/services/vault/transcript-redactor.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vault-redact-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const V = [{ name: "NI", value: "CANARY-T2-file" }, { name: "Home", value: "1 High St\nLondon" }];

function transcript(): string {
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "read my NI" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ppm-sessions__vault_read", input: { items: ["NI"] } }] } },
    { type: "user", uuid: "r1", parentUuid: "a1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Vault items (secure tier).\n- NI (NI number): CANARY-T2-file\n- Home (Address): 1 High St\nLondon" }] }] } },
    { type: "assistant", uuid: "a2", parentUuid: "r1", message: { content: [{ type: "text", text: "Your NI is CANARY-T2-FILE, address 1 High St London." }] } },
    { type: "summary", uuid: "s1", parentUuid: "a2", note: "nothing secret ünïcode" },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("redactJsonlFile", () => {
  it("replaces values in the lines that hold them and keeps every other byte and every link", async () => {
    const f = join(dir, "s.jsonl");
    const original = transcript();
    writeFileSync(f, original);
    expect(await redactJsonlFile(f, V)).toBe("changed");
    const after = readFileSync(f, "utf8");
    expect(after).not.toContain("CANARY");
    expect(after).not.toContain("High St");
    expect(after).toContain("[vault:NI]");
    expect(after).toContain("[vault:Home]");
    const before = original.split("\n");
    const now = after.split("\n");
    expect(now.length).toBe(before.length);
    expect(now[0]).toBe(before[0]);
    expect(now[1]).toBe(before[1]);
    expect(now[4]).toBe(before[4]);
    const parsed = now.filter(Boolean).map((l) => JSON.parse(l) as { uuid: string; parentUuid: string | null });
    expect(parsed.map((p) => [p.uuid, p.parentUuid])).toEqual([["u1", null], ["a1", "u1"], ["r1", "a1"], ["a2", "r1"], ["s1", "a2"]]);
    // No temporary file is left beside it.
    expect(readdirSync(dir)).toEqual(["s.jsonl"]);
  });

  it("answers clean for a file without any value, and leaves it untouched", async () => {
    const f = join(dir, "c.jsonl");
    writeFileSync(f, '{"a":1}\n{"b":"x"}\n');
    expect(await redactJsonlFile(f, V)).toBe("clean");
    expect(readFileSync(f, "utf8")).toBe('{"a":1}\n{"b":"x"}\n');
    expect(readdirSync(dir)).toEqual(["c.jsonl"]);
  });

  it("keeps CRLF line ends and a last line with no newline", async () => {
    const f = join(dir, "crlf.jsonl");
    writeFileSync(f, '{"t":"CANARY-T2-file"}\r\n{"t":"ok"}');
    expect(await redactJsonlFile(f, V)).toBe("changed");
    expect(readFileSync(f, "utf8")).toBe('{"t":"[vault:NI]"}\r\n{"t":"ok"}');
  });

  it("is missing for a file that does not exist", async () => {
    expect(await redactJsonlFile(join(dir, "none.jsonl"), V)).toBe("missing");
  });
});

describe("redactor", () => {
  it("waits for the turn to end and the file to stop growing, then rewrites; retries while busy", async () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(f, transcript());
    let running = true;
    let grows = 2;
    const r = createTranscriptRedactor({
      files: async () => [f],
      running: () => running,
      settleMs: 1,
      stableMs: 1,
      sleep: async () => {
        // The provider is still appending for the first two looks.
        if (grows-- > 0) appendFileSync(f, '{"type":"progress"}\n');
      },
    });
    r.note("s1", [V[0]!]);
    await r.turnEnded("claude", "s1");
    // A turn still running keeps the values pending, untouched.
    expect(readFileSync(f, "utf8")).toContain("CANARY-T2-file");
    expect(r.pendingSessions()).toEqual(["s1"]);
    running = false;
    await r.turnEnded("claude", "s1");
    expect(readFileSync(f, "utf8")).not.toContain("CANARY");
    // Still held: the AI may repeat the value in a later turn of the same chat.
    expect(r.pendingSessions()).toEqual(["s1"]);
    // What the provider appended while it was busy is kept.
    expect(readFileSync(f, "utf8")).toContain('{"type":"progress"}');
  });

  it("clears a value the AI repeats in a later turn, rewriting only when what was appended holds one", async () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(f, transcript());
    const r = createTranscriptRedactor({ files: async () => [f], settleMs: 1, stableMs: 1 });
    r.note("s1", [V[0]!]);
    await r.turnEnded("claude", "s1");
    expect(readFileSync(f, "utf8")).not.toContain("CANARY");
    // A later turn hands out nothing and says nothing secret: the file is left as it is.
    appendFileSync(f, `${JSON.stringify({ type: "assistant", uuid: "a3", parentUuid: "s1", message: { content: [{ type: "text", text: "Done." }] } })}\n`);
    const quiet = readFileSync(f, "utf8");
    await r.turnEnded("claude", "s1");
    expect(readFileSync(f, "utf8")).toBe(quiet);
    // The turn after repeats the value from its context: rewritten, links intact.
    appendFileSync(f, `${JSON.stringify({ type: "assistant", uuid: "a4", parentUuid: "a3", message: { content: [{ type: "text", text: "Again: CANARY-T2-file" }] } })}\n`);
    await r.turnEnded("claude", "s1");
    const after = readFileSync(f, "utf8");
    expect(after).not.toContain("CANARY");
    expect(after).toContain("Again: [vault:NI]");
    expect(after.split("\n").filter(Boolean).map((l) => JSON.parse(l).uuid)).toEqual(["u1", "a1", "r1", "a2", "s1", "a3", "a4"]);
  });

  it("lets a chat's values go once the hold is over", async () => {
    let t = 0;
    const r = createTranscriptRedactor({ files: async () => [], settleMs: 1, stableMs: 1, now: () => t });
    r.note("s1", [V[0]!]);
    t += 24 * 60 * 60_000 + 1;
    await r.turnEnded("claude", "s1");
    expect(r.pendingSessions()).toEqual([]);
  });

  it("does nothing for a session that was handed no value", async () => {
    let asked = 0;
    const r = createTranscriptRedactor({ files: async () => { asked++; return []; }, settleMs: 1, stableMs: 1 });
    await r.turnEnded("claude", "other");
    expect(asked).toBe(0);
  });
});
