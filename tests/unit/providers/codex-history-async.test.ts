import { expect, it } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRolloutMessages } from "../../../src/providers/codex-app-server/codex-history";
import { getRolloutMessagesAsync, parseRolloutJsonlAsync } from "../../../src/providers/codex-app-server/codex-history-async";
import { readRolloutHeader } from "../../../src/providers/codex-app-server/codex-rollout-header";

const fixtures = join(import.meta.dir, "../../fixtures/codex");
const withoutTimestamps = (value: unknown) => JSON.parse(JSON.stringify(value, (key, data) => key === "timestamp" ? undefined : data));

it("keeps the synchronous reader's messages, subagents, errors and project guards", async () => {
  let compared = 0;
  for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".jsonl"))) {
    const header = readRolloutHeader(readFileSync(join(fixtures, file), "utf8"));
    if (!header?.id || !header.cwd) continue;
    expect(withoutTimestamps(await getRolloutMessagesAsync(fixtures, header.id, header.cwd)))
      .toEqual(withoutTimestamps(getRolloutMessages(fixtures, header.id, header.cwd)));
    expect(await getRolloutMessagesAsync(fixtures, header.id, join(tmpdir(), "unrelated-project"))).toEqual([]);
    compared++;
  }
  expect(compared).toBeGreaterThan(2);
});

it("allows other requests to run before a large transcript finishes loading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-history-async-"));
  const id = "11111111-1111-4111-8111-111111111111";
  try {
    const records = [JSON.stringify({ type: "session_meta", payload: { id, cwd: dir } })];
    for (let i = 0; i < 40000; i++) records.push(JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: {
        type: i % 2 ? "agent_message" : "user_message", message: `message ${i} ${"x".repeat(100)}`,
      },
    }));
    const text = records.join("\n") + "\n";
    writeFileSync(join(dir, `rollout-${id}.jsonl`), text);
    let served = false;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { served = true; return new Response("ok"); } });
    await (await fetch(server.url)).text(); // Establish the connection first.
    served = false;
    const health = fetch(server.url).then((response) => response.text());
    try {
      // No file I/O here: the parser itself must let the HTTP request run.
      const messages = await parseRolloutJsonlAsync(text);
      expect(served).toBe(true);
      expect(messages.length).toBe(40000);
      expect(messages.at(-1)?.content).toContain("message 39999");
    } finally { await health; server.stop(true); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
