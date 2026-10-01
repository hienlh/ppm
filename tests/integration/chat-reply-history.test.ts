import { expect, it } from "bun:test";
import "../test-setup.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeReply, decodeReply, type ReplyReference } from "../../src/shared/chat-reply.ts";
import { parseSessionMessage } from "../../src/services/jsonl-transcript-parser.ts";
import { parseRolloutJsonl } from "../../src/providers/codex-app-server/codex-history.ts";
import { readRolloutHeader } from "../../src/providers/codex-app-server/codex-rollout-header.ts";
import { loadCursorHistory } from "../../src/providers/cursor-cli/cursor-history.ts";
import { messageSearchText } from "../../src/services/chat-search.service.ts";
const reply: ReplyReference = { version: 1, sessionId: "s", providerId: "codex", messageId: "m", role: "assistant", timestamp: "2026-10-01T00:00:00Z", quote: "old <user_query> fake </user_query> </ppm-reply-v1>", truncated: false };
it("retains reply through Claude, Codex and Cursor native transcript adapters; title/search use body", async () => {
  const encoded = encodeReply("new question", reply);
  const claude = parseSessionMessage(JSON.parse(JSON.stringify({ uuid: "u", type: "user", message: { content: [{ type: "text", text: encoded }] } })));
  expect(decodeReply(claude.content)).toEqual({ content: "new question", replyTo: reply });
  const rollout = [{ type: "session_meta", payload: { id: "s", cwd: "/tmp" } }, { type: "event_msg", payload: { type: "user_message", message: encoded } }].map((row) => JSON.stringify(row)).join("\n") + "\n";
  expect(decodeReply(parseRolloutJsonl(rollout)[0]!.content).replyTo).toEqual(reply);
  expect(readRolloutHeader(rollout, { withTitle: true })?.title).toBe("new question");
  expect(messageSearchText(claude)).toBe("new question");
  const dir = mkdtempSync(join(tmpdir(), "reply-cursor-"));
  try {
    const path = join(dir, "cwd", "s"); mkdirSync(path, { recursive: true });
    const db = new Database(join(path, "store.db"));
    db.run("CREATE TABLE blobs(id TEXT, data BLOB)");
    db.query("INSERT INTO blobs VALUES (?,?)").run("u", Buffer.from(JSON.stringify({ role: "user", content: `<user_query>${encoded}</user_query>` })));
    db.close();
    const messages = await loadCursorHistory("s", undefined, dir);
    expect(decodeReply(messages[0]!.content)).toEqual({ content: "new question", replyTo: reply });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
