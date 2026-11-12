/**
 * End-to-end integration test for Google Antigravity in PPM.
 *
 * Spawns a real PPM server child process (`src/server/index.ts __serve__`)
 * and verifies over real HTTP & WebSocket connections:
 * 1. Provider registration & models API (`/api/project/:name/chat/providers`)
 * 2. Skill discovery from `.agents/skills/` and `~/.gemini/antigravity/skills/`
 * 3. Session listing & history parsing from `~/.gemini/antigravity/brain/<id>`
 * 4. Live subagent transcript streaming over `/ws/global`
 * 5. Live chat turn streaming over `agy acp` (a fake ACP server) on `/ws/project/:name/chat/:id`
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { rmRetrying } from "../helpers/rm-retrying.ts";

const home = mkdtempSync(join(tmpdir(), "ppm-agy-e2e-serve-"));
const projectDir = join(home, "workspace", "agy-demo");
const logFile = join(home, "serve.log");
const PROJECT_NAME = "agy-proj";
const PARENT_CONV_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const SUBAGENT_CONV_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const LIVE_TURN_CONV_ID = "cccccccc-1111-4222-8333-444444444444";

let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
let wsBase = "";
let authToken = "";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...extra,
  };
}

function writeTranscript(convId: string, lines: unknown[]): void {
  const logsDir = join(home, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, "transcript.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

beforeAll(async () => {
  mkdirSync(join(projectDir, ".git"), { recursive: true });

  // 1. Project-scoped Antigravity skill (.agents/skills/agy-deploy/SKILL.md)
  const projSkillDir = join(projectDir, ".agents", "skills", "agy-deploy");
  mkdirSync(projSkillDir, { recursive: true });
  writeFileSync(
    join(projSkillDir, "SKILL.md"),
    "---\nname: agy-deploy\ndescription: Deploy via Antigravity pipeline\n---\nDeploy instructions.\n",
    "utf-8",
  );

  // 2. User-scoped Antigravity skill (~/.gemini/antigravity/skills/agy-user-helper/SKILL.md)
  const userSkillDir = join(home, ".gemini", "antigravity", "skills", "agy-user-helper");
  mkdirSync(userSkillDir, { recursive: true });
  writeFileSync(
    join(userSkillDir, "SKILL.md"),
    "---\nname: agy-user-helper\ndescription: User-level Antigravity helper\n---\nHelper instructions.\n",
    "utf-8",
  );

  // 3. Project rules & GEMINI.md for shared provider context
  writeFileSync(join(projectDir, "GEMINI.md"), "# Demo Project Gemini Rules\nUse strict TypeScript.\n", "utf-8");

  // 4. Antigravity project config (~/.gemini/config/projects/*.json)
  const agyProjectsDir = join(home, ".gemini", "config", "projects");
  mkdirSync(agyProjectsDir, { recursive: true });
  writeFileSync(
    join(agyProjectsDir, "proj-1.json"),
    JSON.stringify({
      id: "proj-1",
      name: "agy-demo",
      projectResources: {
        resources: [{ gitFolder: { folderUri: `file://${projectDir}`, defaultBranch: "main" } }],
      },
    }),
    "utf-8",
  );

  // 5. Existing parent & subagent conversations in ~/.gemini/antigravity/brain
  writeTranscript(PARENT_CONV_ID, [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-06T10:00:00Z",
      content: "<USER_REQUEST>\nInspect project and spawn subagent\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:02Z",
      thinking: "Reading package.json and invoking research subagent",
      content: "",
      tool_calls: [
        {
          id: "call-read-1",
          name: "read_file",
          args: { Path: JSON.stringify(join(projectDir, "GEMINI.md")) },
        },
        {
          id: "call-sub-1",
          name: "invoke_subagent",
          args: {
            TypeName: '"research"',
            Role: '"Code Researcher"',
            Prompt: '"Check all files"',
          },
        },
      ],
    },
    {
      step_index: 2,
      source: "SYSTEM",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-06T10:00:03Z",
      content: "# Demo Project Gemini Rules",
    },
    {
      step_index: 3,
      source: "SYSTEM",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-06T10:00:04Z",
      content: `Subagent launched with conversationId: ${SUBAGENT_CONV_ID}`,
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:06Z",
      content: "Hoàn tất phân tích dự án.",
    },
  ]);

  writeTranscript(SUBAGENT_CONV_ID, [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-06T10:00:04Z",
      content: "<USER_REQUEST>\nCheck all files\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:05Z",
      thinking: "Subagent checking workspace",
      content: "Subagent research report: everything is clean.",
    },
  ]);

  // 6. A fake `agy` for the live WebSocket turn: the ACP server fixture, answering session/new
  //    with LIVE_TURN_CONV_ID. PPM finds it through ANTIGRAVITY_AGY_EXE.
  const fakeAgyAcp = resolve(import.meta.dir, "../fixtures/fake-agy-acp.ts");
  const fakeAgy = join(home, process.platform === "win32" ? "fake-agy.cmd" : "fake-agy");
  if (process.platform === "win32") {
    writeFileSync(fakeAgy, `@echo off\r\n"${process.execPath}" "${fakeAgyAcp}" --session-id ${LIVE_TURN_CONV_ID} %*\r\n`, "utf-8");
  } else {
    writeFileSync(fakeAgy, `#!/bin/sh\nexec "${process.execPath}" "${fakeAgyAcp}" --session-id ${LIVE_TURN_CONV_ID} "$@"\n`, "utf-8");
    chmodSync(fakeAgy, 0o755);
  }

  // 7. Pick a free port and spawn the real PPM server process with a sanitized env
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);

  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === "INVOCATION_ID" ||
      k === "NOTIFY_SOCKET" ||
      k === "PPM_AI_CHAT" ||
      k === "PPM_ALLOW_PROD_DB" ||
      k.startsWith("ANTHROPIC_") ||
      k.startsWith("CLAUDE_") ||
      k.startsWith("CLAUDE_CODE_") ||
      k.startsWith("OPENAI_") ||
      k.startsWith("CODEX_") ||
      k.startsWith("CURSOR_")
    ) {
      continue;
    }
    cleanEnv[k] = v;
  }

  const logFd = openSync(logFile, "a");
  proc = Bun.spawn({
    cmd: [
      process.execPath,
      resolve(import.meta.dir, "../../src/server/index.ts"),
      "__serve__",
      String(port),
      "127.0.0.1",
      "--minimal",
    ],
    stdio: ["ignore", logFd, logFd],
    env: {
      ...cleanEnv,
      NODE_ENV: "test",
      PPM_HOME: home,
      HOME: home,
      USERPROFILE: home,
      SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      ANTIGRAVITY_AGY_EXE: fakeAgy,
      // Keeps model and quota lookups off the real app's language server, which /proc would find.
      ANTIGRAVITY_LS_ADDRESS: "localhost:43607",
      ANTIGRAVITY_CSRF_TOKEN: "e2e-csrf-token",
    },
  });
  closeSync(logFd);

  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;

  let healthy = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch { /* wait for server */ }
    await Bun.sleep(100);
  }
  if (!healthy) {
    throw new Error(`PPM server did not start:\n${readFileSync(logFile, "utf-8").slice(-2000)}`);
  }

  // 8. Read generated auth token from ppm.db and register the test project via HTTP API
  const db = new Database(join(home, "ppm.db"), { readonly: true });
  const authRow = db.query("SELECT value FROM config WHERE key = 'auth'").get() as { value?: string } | null;
  db.close();
  if (authRow?.value) {
    authToken = (JSON.parse(authRow.value) as { token?: string }).token ?? "";
  }

  const addProjRes = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: projectDir, name: PROJECT_NAME }),
  });
  if (!addProjRes.ok) {
    throw new Error(`Failed to register test project: ${await addProjRes.text()}`);
  }
}, 30_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await rmRetrying(home);
});

describe("Antigravity E2E on a live spawned PPM server process", () => {
  test("GET /chat/providers includes Antigravity and GET /models returns Gemini models", async () => {
    const provRes = await fetch(`${base}/api/project/${PROJECT_NAME}/chat/providers`, {
      headers: authHeaders(),
    });
    expect(provRes.status).toBe(200);
    const provJson = (await provRes.json()) as { ok: boolean; data: Array<{ id: string; name: string }> };
    expect(provJson.ok).toBe(true);
    expect(provJson.data.some((p) => p.id === "antigravity" && p.name === "Antigravity")).toBe(true);

    const modRes = await fetch(`${base}/api/project/${PROJECT_NAME}/chat/providers/antigravity/models`, {
      headers: authHeaders(),
    });
    expect(modRes.status).toBe(200);
    const modJson = (await modRes.json()) as { ok: boolean; data: Array<{ value: string; label: string }> };
    expect(modJson.ok).toBe(true);
    expect(modJson.data.map((m) => m.value)).toContain("gemini-4-argon");
    expect(modJson.data.map((m) => m.value)).toContain("gemini-3.8-flash");
  });

  test("GET /chat/slash-items discovers .agents/skills and ~/.gemini/antigravity/skills", async () => {
    const res = await fetch(`${base}/api/project/${PROJECT_NAME}/chat/slash-items?providerId=antigravity`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { items: Array<{ name: string; scope: string }> } };
    expect(json.ok).toBe(true);
    const names = json.data.items.map((i) => i.name);
    expect(names).toContain("agy-deploy");
    expect(names).toContain("agy-user-helper");
  }, 15_000);

  test("GET /chat/sessions lists parent Antigravity conversation and excludes subagent", async () => {
    const res = await fetch(`${base}/api/project/${PROJECT_NAME}/chat/sessions?providerId=antigravity`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { sessions: Array<{ id: string; title: string }> } };
    expect(json.ok).toBe(true);
    const ids = json.data.sessions.map((s) => s.id);
    expect(ids).toContain(PARENT_CONV_ID);
    expect(ids).not.toContain(SUBAGENT_CONV_ID);
  });

  test("GET /chat/sessions/:id/messages loads parsed Antigravity transcript with normalized tool calls", async () => {
    const res = await fetch(
      `${base}/api/project/${PROJECT_NAME}/chat/sessions/${PARENT_CONV_ID}/messages?providerId=antigravity`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { messages: Array<{ role: string; content: string; events?: Array<{ type: string; tool?: string }> }> };
    };
    expect(json.ok).toBe(true);
    expect(json.data.messages).toHaveLength(2);
    expect(json.data.messages[0]!.content).toBe("Inspect project and spawn subagent");
    expect(json.data.messages[1]!.content).toBe("Hoàn tất phân tích dự án.");

    const toolUses = (json.data.messages[1]!.events ?? []).filter((e) => e.type === "tool_use");
    expect(toolUses.map((t) => t.tool)).toEqual(["Read", "Agent"]);
  });

  test("streams live subagent transcript over /ws/global", async () => {
    const eventsPacket = await new Promise<any>((resolvePacket, rejectPacket) => {
      const ws = new WebSocket(`${wsBase}/ws/global?token=${encodeURIComponent(authToken)}`);
      const timer = setTimeout(() => {
        ws.close();
        rejectPacket(new Error("Timeout waiting for agent-transcript:events over /ws/global"));
      }, 10_000);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "global_ready") {
          ws.send(
            JSON.stringify({
              type: "agent-transcript:subscribe",
              subId: "e2e-sub-1",
              projectName: PROJECT_NAME,
              providerId: "antigravity",
              sessionId: PARENT_CONV_ID,
              source: { kind: "card", cardId: `subagent-${SUBAGENT_CONV_ID}` },
            }),
          );
        } else if (msg.type === "agent-transcript:events" && msg.subId === "e2e-sub-1") {
          clearTimeout(timer);
          ws.close();
          resolvePacket(msg);
        } else if (msg.type === "agent-transcript:error") {
          clearTimeout(timer);
          ws.close();
          rejectPacket(new Error(`agent-transcript:error: ${msg.code} ${msg.message}`));
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        rejectPacket(new Error("WebSocket error on /ws/global"));
      };
    });

    expect(eventsPacket.events.length).toBeGreaterThanOrEqual(2);
    expect(eventsPacket.events.some((e: any) => e.ev.type === "thinking" && e.ev.content.includes("Subagent checking workspace"))).toBe(true);
    expect(eventsPacket.events.some((e: any) => e.ev.type === "text" && e.ev.content.includes("Subagent research report"))).toBe(true);
  });

  test("streams a live chat turn over /ws/project/:name/chat/:sessionId via agy acp", async () => {
    const createRes = await fetch(`${base}/api/project/${PROJECT_NAME}/chat/sessions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "antigravity", title: "Live E2E Chat" }),
    });
    expect(createRes.status).toBe(201);
    const { data: session } = (await createRes.json()) as { data: { id: string } };

    const received = await new Promise<any[]>((resolveEvents, rejectEvents) => {
      const ws = new WebSocket(
        `${wsBase}/ws/project/${PROJECT_NAME}/chat/${session.id}?providerId=antigravity&token=${encodeURIComponent(authToken)}`,
      );
      const msgs: any[] = [];
      let sentPrompt = false;
      const timer = setTimeout(() => {
        ws.close();
        rejectEvents(new Error(`Timeout waiting for chat turn done. Received: ${JSON.stringify(msgs.map((m) => m.type))}`));
      }, 15_000);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        msgs.push(msg);
        if (msg.type === "session_state" && !sentPrompt) {
          sentPrompt = true;
          ws.send(JSON.stringify({ type: "message", content: "hello from the live E2E" }));
        }
        if (msg.type === "done") {
          clearTimeout(timer);
          ws.close();
          resolveEvents(msgs);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        rejectEvents(new Error("Chat WebSocket error"));
      };
    });

    expect(received.some((m) => m.type === "session_migrated" && m.newSessionId === LIVE_TURN_CONV_ID)).toBe(true);
    expect(received.some((m) => m.type === "thinking" && m.content === "Greeting the user")).toBe(true);
    expect(received.filter((m) => m.type === "text").map((m) => m.content).join("")).toBe("Hello");
    expect(received.some((m) => m.type === "done" && m.sessionId === LIVE_TURN_CONV_ID)).toBe(true);
  });
});
