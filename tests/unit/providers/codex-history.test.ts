import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSharedContext } from "../../../src/shared/provider-context.ts";
import { readRolloutHeader } from "../../../src/providers/codex-app-server/codex-rollout-header.ts";
import { parseRolloutJsonl, listCodexRollouts, findRolloutByThreadId, getRolloutMessages, getCodexPreCompactMessages } from "../../../src/providers/codex-app-server/codex-history.ts";

const FIXTURES = join(import.meta.dir, "../../fixtures/codex");
const PPM_CWD = "C:\\Users\\PC\\ppm";

describe("parseRolloutJsonl", () => {
  it("keeps shared provider context out of reloaded messages and titles", () => {
    const prompt = withSharedContext("Fix the login", "Private project memory");
    const text = [
      { type: "session_meta", payload: { id: "shared-context-session", cwd: PPM_CWD } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    expect(parseRolloutJsonl(text)[0]?.content).toBe("Fix the login");
    expect(readRolloutHeader(text, { withTitle: true })?.title).toBe("Fix the login");
  });

  const text = readFileSync(join(FIXTURES, "rollout-real.jsonl"), "utf-8");

  it("reconstructs ordered user/assistant transcript", () => {
    const msgs = parseRolloutJsonl(text);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const user = msgs.find((m) => m.role === "user");
    const asst = msgs.find((m) => m.role === "assistant");
    expect(user?.content).toContain("2+2");
    expect(asst?.content).toBe("4");
    // user precedes assistant
    expect(msgs.indexOf(user!)).toBeLessThan(msgs.indexOf(asst!));
  });

  it("ignores a trailing partial (non-newline-terminated) line", () => {
    const withPartial = text + '{"type":"event_msg","payload":{"type":"user_mess';
    expect(() => parseRolloutJsonl(withPartial)).not.toThrow();
    expect(parseRolloutJsonl(withPartial).length).toBe(parseRolloutJsonl(text).length);
  });

  it("skips corrupt lines without throwing", () => {
    const corrupt = '{bad json\n' + text;
    expect(() => parseRolloutJsonl(corrupt)).not.toThrow();
  });

  it("maps custom_tool_call (apply_patch) → Write/Edit tool_use in history", () => {
    const patch = "*** Begin Patch\\n*** Add File: tests/x.txt\\n+hello\\n*** End Patch\\n";
    const text =
      `{"type":"event_msg","payload":{"type":"user_message","message":"make a file"}}\n` +
      `{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"call_p1","input":"${patch}"}}\n` +
      `{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_p1","output":"Exit code: 0\\nSuccess"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}\n`;
    const msgs = parseRolloutJsonl(text);
    const asst = msgs.find((m) => m.role === "assistant" && m.events?.some((e) => e.type === "tool_use"));
    expect(asst).toBeDefined();
    const tu = asst!.events!.find((e) => e.type === "tool_use") as any;
    expect(tu.tool).toBe("Write");
    expect(tu.input.file_path).toBe("tests/x.txt");
    expect(tu.input.content).toBe("hello");
    expect(asst!.events!.some((e) => e.type === "tool_result" && (e as any).toolUseId === "call_p1")).toBe(true);
  });

  it("compaction: replacement_history replaces pre-compact messages", () => {
    const pre =
      `{"type":"event_msg","payload":{"type":"user_message","message":"old q1"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"old a1"}}\n`;
    const compacted =
      `{"type":"compacted","payload":{"message":"","replacement_history":[` +
      `{"type":"message","role":"user","content":[{"type":"input_text","text":"summary so far"}]},` +
      `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok continuing"}]}]}}\n`;
    const post = `{"type":"event_msg","payload":{"type":"user_message","message":"new q2"}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":"new a2"}}\n`;
    const full = pre + compacted + post;
    const msgs = parseRolloutJsonl(full);
    expect(msgs.map((m) => m.content)).toEqual(["summary so far", "ok continuing", "new q2", "new a2"]);
    expect(msgs.some((m) => m.content === "old q1")).toBe(false); // pre-compact dropped

    // preCompact mode returns the slice BEFORE the compaction boundary
    const preMsgs = parseRolloutJsonl(full, { preCompactIndex: 1 });
    expect(preMsgs.map((m) => m.content)).toEqual(["old q1", "old a1"]);
  });

  /**
   * A thread compacted more than once, which is where the two providers used to
   * disagree. Claude's parser walks back one segment per request; this path
   * stopped at the *first* boundary however many there were, so the newest card
   * answered with the oldest stretch and everything between two compactions was
   * reachable from nothing at all. The fixture is three stretches so that losing
   * the middle one is a visible failure rather than an off-by-one.
   */
  describe("a thread compacted more than once", () => {
    const turn = (u: string, a: string) =>
      `{"type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(u)}}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":${JSON.stringify(a)}}}\n`;
    const compact = (msg: string, replacement: string) =>
      `{"type":"compacted","payload":{"message":${JSON.stringify(msg)},"replacement_history":[` +
      `{"type":"message","role":"user","content":[{"type":"input_text","text":${JSON.stringify(replacement)}}]}]}}\n`;
    // S0 | C1 | S1 | C2 | S2
    const twice =
      turn("q1", "a1") + compact("summary-1", "rh-1") +
      turn("q2", "a2") + compact("summary-2", "rh-2") +
      turn("q3", "a3");

    it("renders the newest stretch, seeded from the newest replacement_history", () => {
      expect(parseRolloutJsonl(twice).map((m) => m.content)).toEqual(["rh-2", "q3", "a3"]);
    });

    it("opens the stretch before the boundary asked for, not the oldest one", () => {
      // The card at the head of the view is C2's, so expanding it must give what C2
      // compacted away — q2/a2. Asking for boundary 1 then gives q1/a1.
      expect(parseRolloutJsonl(twice, { preCompactIndex: 2 }).map((m) => m.content)).toEqual(["q2", "a2"]);
      expect(parseRolloutJsonl(twice, { preCompactIndex: 1 }).map((m) => m.content)).toEqual(["q1", "a1"]);
    });

    it("leaves no stretch unreachable", () => {
      // Every turn in the file is in exactly one of the three answers. This is the
      // assertion the old behaviour failed: q2/a2 appeared in none of them.
      const reachable = [
        ...parseRolloutJsonl(twice, { preCompactIndex: 1 }),
        ...parseRolloutJsonl(twice, { preCompactIndex: 2 }),
        ...parseRolloutJsonl(twice),
      ].map((m) => m.content);
      for (const turnText of ["q1", "a1", "q2", "a2", "q3", "a3"]) {
        expect(reachable, `"${turnText}" is reachable from some card`).toContain(turnText);
      }
    });

    it("stops at the last boundary when fewer exist than were asked for", () => {
      // An index past the end is a stale client, not a reason to answer with nothing.
      expect(parseRolloutJsonl(twice, { preCompactIndex: 9 }).map((m) => m.content)).toEqual(["q3", "a3"]);
    });
  });

  it("honors thread_rolled_back (drops last N turns)", () => {
    const turn = (u: string, a: string) =>
      `{"type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(u)}}}\n` +
      `{"type":"event_msg","payload":{"type":"agent_message","message":${JSON.stringify(a)}}}\n`;
    // 3 turns, then rollback 2, then 1 new turn → expect turns: t1 + t4 (2 user, 2 assistant)
    const rolled = turn("q1", "a1") + turn("q2", "a2") + turn("q3", "a3") +
      `{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":2}}\n` +
      turn("q4", "a4");
    const msgs = parseRolloutJsonl(rolled);
    const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
    const asst = msgs.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(users).toEqual(["q1", "q4"]);
    expect(asst).toEqual(["a1", "a4"]);
  });

  it("nests tool calls into assistant events (function_call + output)", () => {
    const toolsText = readFileSync(join(FIXTURES, "rollout-with-tools.jsonl"), "utf-8");
    const msgs = parseRolloutJsonl(toolsText);
    const asstWithTools = msgs.find((m) => m.role === "assistant" && m.events?.some((e) => e.type === "tool_use"));
    expect(asstWithTools).toBeDefined();
    const tu = asstWithTools!.events!.find((e) => e.type === "tool_use") as any;
    const tr = asstWithTools!.events!.find((e) => e.type === "tool_result") as any;
    expect(["Bash", "PowerShell"]).toContain(tu.tool);
    expect(tu.input.command).toBeTruthy();
    expect(tu.toolUseId).toMatch(/^call_/);
    // tool_use ↔ tool_result paired by call_id
    expect(asstWithTools!.events!.some((e) => e.type === "tool_result" && (e as any).toolUseId === tu.toolUseId)).toBe(true);
    expect(typeof tr.output).toBe("string");
  });
});

/**
 * The card that heads a compacted view, written to a temp sessions dir so the
 * summary text and the boundary index can be read off a real file.
 *
 * Two things ride on that card: it is what the user reads to know what was
 * compacted away, and its id is what the client posts back as `before`. Both were
 * taken from the *first* compaction however many there were.
 */
describe("the compact card on a twice-compacted thread", () => {
  const THREAD = "019eded7-1111-2222-3333-444455556666";
  const CWD = "/tmp/ppm-codex-card";
  let dir: string;

  const turn = (u: string) =>
    `{"type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(u)}}}\n`;
  const compact = (msg: string) =>
    `{"type":"compacted","payload":{"message":${JSON.stringify(msg)},"replacement_history":[` +
    `{"type":"message","role":"user","content":[{"type":"input_text","text":"rh"}]}]}}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-codex-"));
    writeFileSync(
      join(dir, `rollout-2026-09-16T10-00-00-${THREAD}.jsonl`),
      `{"type":"session_meta","payload":{"id":"${THREAD}","cwd":"${CWD}"}}\n` +
        turn("q1") + compact("summary-1") + turn("q2") + compact("summary-2") + turn("q3"),
      "utf-8",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("shows the summary of the compaction that produced this view", () => {
    const head = getRolloutMessages(dir, THREAD, CWD)[0]!;
    expect(head.content).toContain("summary-2");
    expect(head.content).not.toContain("summary-1");
  });

  it("names the boundary in its id, so `before` can say which one to walk back from", () => {
    expect(getRolloutMessages(dir, THREAD, CWD)[0]!.id).toBe(`codex-compact-${THREAD}#2`);
  });

  it("carries the transcript marker the client greps for", () => {
    expect(getRolloutMessages(dir, THREAD, CWD)[0]!.content).toMatch(/read the full transcript at:\s*\S+\.jsonl/);
  });
});

/**
 * The "load more" walk, which had no test at all.
 *
 * `isCodexRolloutPath` jails to `~/.codex/sessions` via `homedir()`, and `homedir()` reads
 * `USERPROFILE`/`HOME` — so the home is pointed at a temp directory for the duration rather
 * than the real one being written to, and both variables are put back afterwards.
 */
describe("getCodexPreCompactMessages", () => {
  const THREAD = "019eded7-aaaa-bbbb-cccc-ddddeeeeffff";
  const CWD = "/tmp/ppm-codex-walk";
  let home: string;
  let file: string;
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

  const turn = (u: string) =>
    `{"type":"event_msg","payload":{"type":"user_message","message":${JSON.stringify(u)}}}\n`;
  const compact = (msg: string) =>
    `{"type":"compacted","payload":{"message":${JSON.stringify(msg)},"replacement_history":[` +
    `{"type":"message","role":"user","content":[{"type":"input_text","text":"rh"}]}]}}\n`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ppm-codex-home-"));
    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    file = join(sessions, `rollout-2026-09-16T10-00-00-${THREAD}.jsonl`);
    writeFileSync(
      file,
      `{"type":"session_meta","payload":{"id":"${THREAD}","cwd":"${CWD}"}}\n` +
        turn("q1") + compact("summary-1") + turn("q2") + compact("summary-2") + turn("q3"),
      "utf-8",
    );
    process.env.USERPROFILE = home;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const texts = (msgs: { content: string }[]) => msgs.map((m) => m.content).join("\n");

  it("opens one segment per request, not everything before the first boundary", () => {
    // Three stretches, two boundaries. Clicking the newest card must hand back the *middle*
    // stretch — returning the oldest left the middle one reachable from nothing at all.
    const segment = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#2`);
    const body = texts(segment);
    expect(body).toContain("q2");
    expect(body).not.toContain("q3");
  });

  it("heads that segment with the previous boundary's card, so the walk continues", () => {
    const segment = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#2`);
    expect(segment[0]!.id).toBe(`codex-compact-${THREAD}#1`);
    expect(segment[0]!.content).toContain("summary-1");
  });

  it("stops at the oldest segment rather than offering a card that leads nowhere", () => {
    const segment = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#1`);
    expect(texts(segment)).toContain("q1");
    expect(segment.some((m) => m.id.startsWith("codex-compact-"))).toBe(false);
  });

  it("treats a card id from before the index existed as the newest boundary", () => {
    // A client holding an old bare id must not get a different answer from a `#2` one.
    const bare = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}`);
    const numbered = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#2`);
    expect(texts(bare)).toBe(texts(numbered));
  });

  it("clamps an index that names a boundary this thread does not have", () => {
    const asked = getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#9`);
    expect(texts(asked)).toBe(texts(getCodexPreCompactMessages(file, CWD, `codex-compact-${THREAD}#2`)));
  });

  it("answers nothing for a thread belonging to another project (fail-closed)", () => {
    expect(getCodexPreCompactMessages(file, "/some/other/project")).toEqual([]);
  });

  it("refuses a path outside the sessions directory", () => {
    const outside = join(home, "not-a-session.jsonl");
    writeFileSync(outside, "{}\n", "utf-8");
    expect(() => getCodexPreCompactMessages(outside, CWD)).toThrow(/Access denied/);
  });

  it("answers nothing when the thread was never compacted", () => {
    const plain = join(home, ".codex", "sessions", `rollout-2026-09-16T11-00-00-${THREAD}.jsonl`);
    writeFileSync(plain, `{"type":"session_meta","payload":{"id":"x","cwd":"${CWD}"}}\n` + turn("only"), "utf-8");
    expect(getCodexPreCompactMessages(plain, CWD)).toEqual([]);
  });
});

describe("listCodexRollouts (fail-closed cwd filter)", () => {
  it("returns ONLY rollouts whose session_meta cwd matches the requested dir", () => {
    const sessions = listCodexRollouts(FIXTURES, PPM_CWD, "codex");
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("019eded7-3947-7990-a06e-bf9a29c25f26"); // ppm-cwd fixture
    expect(ids).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"); // D:\ fixture excluded
  });

  it("excludes rollouts from a different cwd", () => {
    const sessions = listCodexRollouts(FIXTURES, "D:\\other\\project", "codex");
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("returns nothing for an unrelated cwd (fail-closed)", () => {
    expect(listCodexRollouts(FIXTURES, "/nonexistent/path", "codex")).toEqual([]);
  });

  if (process.platform === "win32") {
    it("matches cwd case-insensitively on win32", () => {
      // Assert membership, not a count: every rollout sharing this cwd matches,
      // and a fixture added later must not make the case check look broken.
      const ids = listCodexRollouts(FIXTURES, PPM_CWD.toLowerCase(), "codex").map((s) => s.id);
      expect(ids).toContain("019eded7-3947-7990-a06e-bf9a29c25f26");
      expect(ids).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });
  }
});

describe("findRolloutByThreadId / getRolloutMessages (fail-closed resume/read path)", () => {
  const PPM_ID = "019eded7-3947-7990-a06e-bf9a29c25f26";
  const OTHER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("finds a thread when cwd matches", () => {
    expect(findRolloutByThreadId(FIXTURES, PPM_ID, PPM_CWD)).not.toBeNull();
  });

  it("does NOT return another project's thread when cwd mismatches (fail-closed)", () => {
    expect(findRolloutByThreadId(FIXTURES, OTHER_ID, PPM_CWD)).toBeNull();
    expect(getRolloutMessages(FIXTURES, OTHER_ID, PPM_CWD)).toEqual([]);
  });

  it("returns messages only for a cwd-attributable thread", () => {
    expect(getRolloutMessages(FIXTURES, PPM_ID, PPM_CWD).length).toBeGreaterThanOrEqual(2);
    // correct id but wrong cwd → fail-closed empty
    expect(getRolloutMessages(FIXTURES, PPM_ID, "D:\\other\\project")).toEqual([]);
  });

  it("ignores loose substring ids (anchored match only)", () => {
    expect(findRolloutByThreadId(FIXTURES, "019eded7", PPM_CWD)).toBeNull();
  });
});

describe("subagent threads (spawned agents are steps, not sessions)", () => {
  const PARENT_ID = "11111111-1111-4111-8111-111111111111";
  const CHILD_ID = "22222222-2222-4222-8222-222222222222";

  it("excludes a spawned subagent's rollout from the session list", () => {
    const ids = listCodexRollouts(FIXTURES, PPM_CWD, "codex").map((s) => s.id);
    expect(ids).toContain(PARENT_ID);
    expect(ids).not.toContain(CHILD_ID); // same cwd, but it is one step of the parent
  });

  it("titles a session with its opening prompt instead of a fixed label", () => {
    const parent = listCodexRollouts(FIXTURES, PPM_CWD, "codex").find((s) => s.id === PARENT_ID);
    expect(parent?.title).toBe("don dep lai codex login service giup minh"); // whitespace collapsed
  });

  it("nests the spawned thread's transcript under one Agent card in the parent", () => {
    const msgs = getRolloutMessages(FIXTURES, PARENT_ID, PPM_CWD);
    const events = msgs.flatMap((m) => m.events ?? []);
    const cards = events.filter((e) => e.type === "tool_use" && (e as any).tool === "Agent") as any[];
    // started + completed describe ONE card; the second spawn is the dead agent below
    expect(cards.map((c) => c.input.description)).toEqual(["/root/simplify_login", "/root/review_login"]);

    const childEvents = cards[0].children as any[];
    expect(childEvents.some((e) => e.type === "tool_use" && e.tool === "Bash")).toBe(true);
    expect(childEvents.some((e) => e.type === "text" && e.content.includes("simplify pass"))).toBe(true);

    // The completion answers that card, carrying the agent's closing report.
    const result = events.find((e) => e.type === "tool_result" && (e as any).toolUseId === cards[0].toolUseId) as any;
    expect(result.output).toContain("Status: DONE");
  });

  it("says why an agent that died before reporting produced nothing", () => {
    const events = getRolloutMessages(FIXTURES, PARENT_ID, PPM_CWD).flatMap((m) => m.events ?? []);
    const dead = events.find((e: any) => e.input?.description === "/root/review_login") as any;
    // No completion was ever recorded for it, so the reason has to live in the card.
    expect(events.some((e: any) => e.toolUseId === dead.toolUseId && e.type === "tool_result")).toBe(false);
    expect(dead.children[0].content).toBe(
      "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    ); // unwrapped from the API error codex nests as JSON
  });

  it("still resolves the subagent rollout by id (the parent has to read it)", () => {
    expect(findRolloutByThreadId(FIXTURES, CHILD_ID, PPM_CWD)).not.toBeNull();
  });
});
