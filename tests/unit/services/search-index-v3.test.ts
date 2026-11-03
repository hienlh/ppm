import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  closeSearchIndexDb, getSearchIndexDb, getSearchIndexPath, openTestSearchIndexDb, SEARCH_INDEX_FILE, setSearchIndexDb,
} from "../../../src/services/search-index-db.service.ts";
import { indexMessages, messageSearchColumns, search } from "../../../src/services/chat-search.service.ts";
import { searchSessionTitles, searchSessionTurnText } from "../../../src/services/session-turns/session-search.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

const PROJ = "/proj/v3";
const at = "2026-11-01T00:00:00.000Z";
const toolTurn: ChatMessage = {
  id: "m1", role: "assistant", content: "", timestamp: at, turnId: "aaaaaaaa-0000-4000-8000-000000000001", turnN: 2,
  events: [
    { type: "text", content: "I checked the config" },
    { type: "tool_use", tool: "Bash", input: { command: "printenv" } },
    { type: "tool_result", output: "OPENAI_KEY=platypus-secret" },
    { type: "tool_use", tool: "Agent", input: {}, children: [{ type: "text", content: "subagent narration wombat" }] },
  ],
};

afterAll(() => closeSearchIndexDb());

describe("search index v3", () => {
  it("splits prose from tool text", () => {
    const { text, toolText } = messageSearchColumns(toolTurn);
    expect(text).toBe("I checked the config");
    expect(toolText).toContain("platypus-secret");
    expect(toolText).toContain("wombat");
    expect(text).not.toContain("platypus");
  });

  it("the AI mode never matches or quotes tool text; the chat's search box still matches both", () => {
    setSearchIndexDb(openTestSearchIndexDb());
    indexMessages("11111111-2222-4333-8444-555555555555", PROJ, [toolTurn], 1, { providerId: "codex", title: "Config check" });
    expect(searchSessionTurnText(PROJ, "platypus", 20)).toEqual([]);
    expect(searchSessionTurnText(PROJ, "wombat", 20)).toEqual([]);
    expect(searchSessionTurnText(PROJ, "printenv", 20)).toEqual([]);
    const prose = searchSessionTurnText(PROJ, "config", 20);
    expect(prose).toEqual([{
      sessionId: "11111111-2222-4333-8444-555555555555", providerId: "codex", title: "Config check",
      turnId: "aaaaaaaa-0000-4000-8000-000000000001", turnN: 2, role: "assistant", ts: at, snippet: "I checked the config",
    }]);
    expect(search(PROJ, "platypus", 10).map((h) => h.messageId)).toEqual(["m1"]);
    expect(search(PROJ, "platypus", 10)[0]!.snippet).toContain("<mark>");
    expect(searchSessionTitles(PROJ, "config", 10).map((t) => t.title)).toEqual(["Config check"]);
    expect(searchSessionTitles(PROJ, "%", 10)).toEqual([]);
    expect(searchSessionTitles("/proj/other", "config", 10)).toEqual([]);
  });

  it("writes a new file and leaves the old index untouched", () => {
    closeSearchIndexDb();
    const old = join(getPpmDir(), "search-index.db");
    writeFileSync(old, "an older build's index");
    const before = statSync(old).mtimeMs;
    const db = getSearchIndexDb();
    expect(getSearchIndexPath()).toBe(join(getPpmDir(), SEARCH_INDEX_FILE));
    expect(existsSync(join(getPpmDir(), SEARCH_INDEX_FILE))).toBe(true);
    const cols = (db.query("PRAGMA table_info(messages_fts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["text", "tool_text", "session_id", "project_path", "message_id", "turn_id", "turn_n", "role", "ts"]);
    expect(readFileSync(old, "utf8")).toBe("an older build's index");
    expect(statSync(old).mtimeMs).toBe(before);
    closeSearchIndexDb();
  });
});
