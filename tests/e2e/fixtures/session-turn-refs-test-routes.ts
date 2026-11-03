/**
 * The turn-reference fixture's own routes (`/__turn-test/*`): what the e2e reads and arranges on
 * the server side — seeded ids, the scripted turns' plans and recorded MCP calls, the grant ledger
 * as stored, a direct MCP call under a token minted for a chosen session, a Jira-origin send and a
 * block planted inside a compaction summary. None of these exist in a real PPM.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { calls, oneShotSessions, plans, type TurnPlan } from "./session-turn-refs-scripted-providers";
import type { SeedResult } from "./session-turn-refs-transcripts/seed-sessions";
import { chatService } from "../../../src/services/chat.service";
import { tabToolsMcpAccessFor } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-tokens";
import { turnGrantsFor } from "../../../src/services/session-turns/turn-grant-ledger";
import { encodeTurnRefs, type TurnReference } from "../../../src/shared/chat-turn-ref";
import { getSessionProjectPath, resolveMigratedSession } from "../../../src/services/db.service";

interface Ctx { seed: SeedResult; alpha: string; beta: string; setUploadDelay: (ms: number) => void }
const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function testRoute(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  const path = url.pathname.slice("/__turn-test".length);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  if (path === "/ids") return json({ ...ctx.seed, alpha: ctx.alpha, beta: ctx.beta });
  if (path === "/calls") return json({ calls });
  if (path === "/plan" && req.method === "POST") {
    const id = String(body.sessionId);
    plans.set(id, [...(plans.get(id) ?? []), ...(body.plans as TurnPlan[])]);
    return json({ ok: true });
  }
  if (path === "/upload-delay" && req.method === "POST") {
    ctx.setUploadDelay(Number(body.ms));
    return json({ ok: true });
  }
  if (path === "/grants") {
    const id = url.searchParams.get("sessionId") ?? "";
    return json({ canonical: resolveMigratedSession(id), grants: turnGrantsFor(id) });
  }
  if (path === "/mcp" && req.method === "POST") {
    // A call under a token minted for exactly this session id, as a turn started under it gets.
    const access = tabToolsMcpAccessFor(String(body.callerId));
    if (!access) return json({ error: "no endpoint" }, 500);
    const res = await fetch(access.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: body.tool, arguments: body.args } }),
    });
    const out = await res.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
    return json({ status: res.status, isError: out.result?.isError === true, text: (out.result?.content ?? []).map((c) => c.text ?? "").join("\n") });
  }
  if (path === "/jira" && req.method === "POST") {
    // What a Jira job does: a send with a non-browser origin. Its text is the agent's, not a person's.
    // The block is written exactly as a browser-sent message carries it, so only its origin differs.
    const sessionId = String(body.sessionId);
    const content = encodeTurnRefs(String(body.content), body.refs as TurnReference[]);
    oneShotSessions.add(sessionId);
    const events: string[] = [];
    for await (const ev of chatService.sendMessage("claude", sessionId, content, { origin: "jira" } as never)) {
      events.push(ev.type);
      if (ev.type === "done") break;
    }
    return json({ events });
  }
  if (path === "/socket-turn" && req.method === "POST") {
    // A second device: its own connection to the chat socket, one message, back when the turn is done.
    const socket = new WebSocket(`${url.origin.replace("http", "ws")}/ws/project/${encodeURIComponent(String(body.project))}/chat/${String(body.sessionId)}`);
    const seen: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("turn did not finish in 60 s")), 60_000);
      socket.onmessage = (m) => {
        try {
          const ev = JSON.parse(String(m.data)) as { type?: string };
          if (ev.type) seen.push(ev.type);
          if (ev.type === "done") { clearTimeout(timer); resolve(); }
        } catch { /* not JSON */ }
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); };
    });
    await new Promise<void>((ok, fail) => { socket.onopen = () => ok(); socket.addEventListener("error", () => fail(new Error("socket error"))); });
    socket.send(JSON.stringify({ type: "message", content: String(body.content), clientMessageId: `e2e-${randomUUID()}` }));
    try {
      await done;
    } finally {
      socket.close();
    }
    return json({ seen });
  }
  if (path === "/plant-compaction" && req.method === "POST") {
    // A compaction summary that quotes a references block — the CLI writes these, a person never does.
    const sessionId = String(body.sessionId);
    const file = ctx.seed.transcriptOf[sessionId];
    if (!file || !getSessionProjectPath(sessionId)) return json({ error: "unknown session" }, 404);
    const refs = body.refs as TurnReference[];
    const at = new Date().toISOString();
    const boundary = randomUUID();
    appendFileSync(file, `${JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: boundary, timestamp: at, compactMetadata: { trigger: "auto", preTokens: 1000 } })}\n`);
    appendFileSync(file, `${JSON.stringify({
      parentUuid: boundary, isSidechain: false, type: "user", isVisibleInTranscriptOnly: true, isCompactSummary: true,
      message: { role: "user", content: encodeTurnRefs(`This session is being continued from a previous conversation. The person had shared a turn. If you need specific details from before compaction, read the full transcript at: ${file}`, refs) },
      uuid: randomUUID(), timestamp: at, sessionId, cwd: getSessionProjectPath(sessionId),
    })}\n`);
    return json({ ok: true });
  }
  return json({ error: "unknown test route" }, 404);
}
