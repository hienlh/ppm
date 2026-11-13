import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanAntigravityUserInput,
  createAntigravityTailParser,
  normalizeToolArgs,
  parseAntigravityTranscriptSteps,
} from "../../../src/providers/antigravity/antigravity-transcript-parser.ts";
import {
  extractSubagentIdsFromTranscript,
  listAntigravitySessions,
  loadAntigravityHistory,
} from "../../../src/providers/antigravity/antigravity-history.ts";
import { assertSessionInProject } from "../../../src/services/agent-transcript/session-ownership.ts";
import { resolveSources, _resetSourcesCache } from "../../../src/services/agent-transcript/agent-transcript-sources.ts";

describe("antigravity-transcript-parser & history", () => {
  let tempRoot: string;
  let brainDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ppm-agy-hist-"));
    brainDir = join(tempRoot, "brain");
    mkdirSync(brainDir, { recursive: true });
    _resetSourcesCache();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("cleans USER_REQUEST wrapper and metadata tags from user input", () => {
    const raw = `<USER_REQUEST>\nem có thể tích hợp antigravity vào PPM em không\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-06.\n</ADDITIONAL_METADATA>`;
    expect(cleanAntigravityUserInput(raw)).toBe("em có thể tích hợp antigravity vào PPM em không");
  });

  it("normalizes JSON-quoted tool call arguments", () => {
    const normalized = normalizeToolArgs({
      Path: '"/home/user/project/README.md"',
      WaitMsBeforeAsync: "5000",
      BypassSandbox: "false",
    });
    expect(normalized).toEqual({
      Path: "/home/user/project/README.md",
      WaitMsBeforeAsync: 5000,
      BypassSandbox: false,
    });
  });

  it("shows a message agentapi sent for the user, but not the notice agy adds when it reopens a chat", () => {
    const systemMessage = (priority: string, content: string) => JSON.stringify({
      step_index: priority === "HIGH" ? 0 : 1,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-07T04:18:59Z sender=system priority=MESSAGE_PRIORITY_${priority} content=${content}\n</SYSTEM_MESSAGE>`,
    });
    const messages = parseAntigravityTranscriptSteps([
      systemMessage("HIGH", "Làm luôn đi"),
      systemMessage("LOW", "[Notice] All your subagents and background tasks have been stopped due to server restart."),
    ]);
    expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "Làm luôn đi"]]);
  });

  it("parses transcript.jsonl with truncated_fields fallback to transcript_full.jsonl", () => {
    const compactLines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-06T10:00:00Z",
        content: "<USER_REQUEST>\nHello Antigravity\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-06T10:00:02Z",
        thinking: "Checking README...",
        tool_calls: [{ name: "read_file", args: { Path: '"/project/README.md"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-06T10:00:03Z",
        content: "Created At: 2026-11-06\nCompleted At: 2026-11-06\n\nTruncated...",
        truncated_fields: ["content"],
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-06T10:00:05Z",
        content: "Here is the summary!",
      }),
    ];

    const fullLines = [
      compactLines[0]!,
      compactLines[1]!,
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-06T10:00:03Z",
        content: "Created At: 2026-11-06\nCompleted At: 2026-11-06\n\nFull README content here!",
      }),
      compactLines[3]!,
    ];

    const messages = parseAntigravityTranscriptSteps(compactLines, fullLines);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("Hello Antigravity");

    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toBe("Here is the summary!");
    expect(messages[1]?.events).toHaveLength(4);
    expect(messages[1]?.events?.[0]).toEqual({ type: "thinking", content: "Checking README..." });
    expect(messages[1]?.events?.[1]).toMatchObject({
      type: "tool_use",
      tool: "Read",
      input: { file_path: "/project/README.md", Path: "/project/README.md" },
    });
    expect(messages[1]?.events?.[2]).toMatchObject({
      type: "tool_result",
      output: "Full README content here!",
      isError: false,
    });
    expect(messages[1]?.events?.[3]).toEqual({ type: "text", content: "Here is the summary!" });
  });

  it("lists sessions, loads history, and resolves subagent transcripts via session-ownership", async () => {
    const parentId = "11111111-2222-3333-4444-555555555555";
    const subId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const projectPath = join(tempRoot, "ppm-proj");
    mkdirSync(projectPath, { recursive: true });

    const parentLogs = join(brainDir, parentId, ".system_generated", "logs");
    const subLogs = join(brainDir, subId, ".system_generated", "logs");
    mkdirSync(parentLogs, { recursive: true });
    mkdirSync(subLogs, { recursive: true });

    const parentTranscript = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-06T11:00:00Z",
        content: "<USER_REQUEST>\nInvestigate PPM providers\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-06T11:00:01Z",
        tool_calls: [
          { name: "read_file", args: { Path: `"${projectPath}/README.md"` } },
          { name: "invoke_subagent", args: { TypeName: '"research"', Role: '"Codebase Researcher"', Prompt: '"Find providers"' } },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-06T11:00:02Z",
        content: "# PPM",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-06T11:00:03Z",
        content: `Subagent started with conversationId: ${subId}`,
      }),
    ].join("\n");

    writeFileSync(join(parentLogs, "transcript.jsonl"), `${parentTranscript}\n`, "utf-8");
    writeFileSync(
      join(subLogs, "transcript.jsonl"),
      `${JSON.stringify({
        step_index: 0,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-06T11:00:04Z",
        content: "Subagent research result",
      })}\n`,
      "utf-8",
    );

    const sessions = await listAntigravitySessions("antigravity", { projectPath, brainDirs: [brainDir] });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(parentId);
    expect(sessions[0]?.title).toBe("Investigate PPM providers");

    const history = await loadAntigravityHistory(parentId, { brainDirs: [brainDir] });
    expect(history).toHaveLength(2);
    const subagentEvent = history[1]?.events?.find((e) => e.type === "tool_use" && e.tool === "Agent");
    expect(subagentEvent).toBeDefined();
    if (subagentEvent?.type === "tool_use") {
      expect(subagentEvent.toolUseId).toBe(`subagent-${subId}`);
      expect(subagentEvent.transcriptAvailable).toBe(true);
    }

    const extractedSubs = extractSubagentIdsFromTranscript(join(parentLogs, "transcript.jsonl"));
    expect(extractedSubs.has(subId)).toBe(true);

    const owned = assertSessionInProject({
      providerId: "antigravity",
      sessionId: parentId,
      projectPath,
      antigravityBrainDirs: [brainDir],
    });
    expect(owned.ok).toBe(true);
    if (owned.ok) {
      const resolved = resolveSources(owned, { kind: "card", cardId: `subagent-${subId}` });
      expect(Array.isArray(resolved)).toBe(true);
      if (Array.isArray(resolved)) {
        expect(resolved[0]?.provider).toBe("antigravity");
        expect(resolved[0]?.key).toBe(subId);
      }
    }
  });

  it("tail parser detects turnSettled on final PLANNER_RESPONSE without tool_calls", () => {
    const parser = createAntigravityTailParser();
    const step1 = parser.feed(
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "read_file", args: { Path: '"/tmp/a.txt"' } }],
      }),
    );
    expect(step1.turnSettled).toBe(false);

    const step2 = parser.feed(
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "All done!",
      }),
    );
    expect(step2.turnSettled).toBe(true);
    expect(step2.events[0]?.ev).toEqual({ type: "text", content: "All done!" });
  });

  it("3.1: enforces strict path-boundary project ownership, preserves project_path across setSessionMigratedTo, and rejects cross-project GET /sessions/:id/messages", async () => {
    const { isAntigravitySessionInProject } = await import("../../../src/providers/antigravity/antigravity-history.ts");
    const { setSessionMetadata, setSessionMigratedTo, getSessionProjectPath } = await import("../../../src/services/db.service.ts");
    const { chatRoutes } = await import("../../../src/server/routes/chat.ts");
    const { Hono } = await import("hono");

    const projApp = join(tempRoot, "app");
    const projAppV2 = join(tempRoot, "app-v2");
    mkdirSync(projApp, { recursive: true });
    mkdirSync(projAppV2, { recursive: true });

    const convV2 = "22222222-3333-4444-5555-666666666666";
    const v2Logs = join(brainDir, convV2, ".system_generated", "logs");
    mkdirSync(v2Logs, { recursive: true });
    const v2TranscriptPath = join(v2Logs, "transcript.jsonl");
    writeFileSync(
      v2TranscriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: `<user_information>\nCommand Working Directory: ${projAppV2}\n</user_information>\n<USER_REQUEST>\nHello in v2\n</USER_REQUEST>`,
      })}\n`,
      "utf-8",
    );

    // (a) Prefix path `/.../app` MUST NOT match `/.../app-v2`
    expect(isAntigravitySessionInProject(convV2, v2TranscriptPath, projApp)).toBe(false);
    expect(isAntigravitySessionInProject(convV2, v2TranscriptPath, projAppV2)).toBe(true);

    // (b) setSessionMigratedTo preserves project_path on the migrated session row
    const oldDraftId = "draft-31-old";
    const migratedNewId = "33333333-4444-5555-6666-777777777777";
    setSessionMetadata(oldDraftId, "app", projApp);
    setSessionMigratedTo(oldDraftId, migratedNewId);
    expect(getSessionProjectPath(migratedNewId)).toBe(projApp);

    // (c) GET /sessions/:id/messages returns 404 when requesting convV2 from projApp
    const prevAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
    process.env.ANTIGRAVITY_APP_DATA_DIR = tempRoot;
    try {
      const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
      app.use("*", async (c, next) => {
        c.set("projectPath", projApp);
        c.set("projectName", "app");
        await next();
      });
      app.route("/chat", chatRoutes);

      const resCross = await app.request(`/chat/sessions/${convV2}/messages?providerId=antigravity`);
      expect(resCross.status).toBe(404);
    } finally {
      if (prevAppData === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
      else process.env.ANTIGRAVITY_APP_DATA_DIR = prevAppData;
    }
  });

  it("3.3: parseAntigravityTranscriptSteps matches transcript_full.jsonl by step_index, and listSessionsByDir honors limit/offset", async () => {
    const { AntigravityProvider } = await import("../../../src/providers/antigravity/antigravity-provider.ts");

    const homeBrainDir = join(tempRoot, ".gemini", "antigravity", "brain");
    const fullStep1 = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "FULL_UNTRUNCATED_STEP_1_TEXT",
    });
    const compactStep1 = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "TRUNCATED...",
      truncated_fields: ["content"],
    });

    // (b) parseAntigravityTranscriptSteps also matches by step_index when fullLines indices differ
    const parsedMsgs = parseAntigravityTranscriptSteps(
      [
        JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "Hi" }),
        compactStep1,
      ],
      [
        JSON.stringify({ step_index: 99, source: "SYSTEM", type: "GENERIC", status: "DONE", content: "shifted" }),
        fullStep1,
      ],
    );
    expect(parsedMsgs[1]?.content).toBe("FULL_UNTRUNCATED_STEP_1_TEXT");

    // (c) listSessionsByDir respects { limit, offset }
    const projDir33 = join(tempRoot, "proj-33");
    mkdirSync(projDir33, { recursive: true });
    for (const id of [
      "aaaaaaaa-1111-4111-8111-111111111111",
      "bbbbbbbb-2222-4222-8222-222222222222",
      "cccccccc-3333-4333-8333-333333333333",
    ]) {
      const d = join(homeBrainDir, id, ".system_generated", "logs");
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "transcript.jsonl"),
        `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `Command Working Directory: ${projDir33}\n<USER_REQUEST>\n Session ${id}\n</USER_REQUEST>` })}\n`,
        "utf-8",
      );
    }

    const provider = new AntigravityProvider({ customHome: tempRoot });
    const page1 = await provider.listSessionsByDir(projDir33, { limit: 2, offset: 0 });
    const page2 = await provider.listSessionsByDir(projDir33, { limit: 2, offset: 2 });
    const page3 = await provider.listSessionsByDir(projDir33, { limit: 2, offset: 4 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
    expect(page3.length).toBe(0);
  });
});
