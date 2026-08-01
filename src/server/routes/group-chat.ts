import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  createGroup,
  getGroup,
  listGroups,
  deleteGroup,
  addMember,
  getMember,
  updateMember,
  removeMember,
  listMembers,
  readMessages,
  setGroupMaxTurns,
} from "../../services/group-chat/group-chat.store.ts";
import { groupChatService } from "../../services/group-chat/group-chat.service.ts";
import { resolveTranscriptPath } from "../../services/group-chat/transcript-archive.ts";
import { parseJsonlTranscript, parseTranscriptConfig } from "../../services/jsonl-transcript-parser.ts";
import type { AddMemberInput, UpdateMemberInput } from "../../types/group-chat.ts";

/** Allowlist: group ids are UUIDs — alphanumeric + hyphens only. */
const VALID_GROUP_ID = /^[a-zA-Z0-9-]+$/;
/** Member ids are UUIDs too. */
const VALID_MEMBER_ID = /^[a-zA-Z0-9-]+$/;
/** Session refs are Claude session UUIDs. */
const VALID_SESSION_REF = /^[a-zA-Z0-9-]+$/;

export const groupChatRoutes = new Hono();

interface CreateBody {
  projectName?: string;
  projectPath?: string;
  name?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  members?: Array<{ role?: string; name?: string; persona?: string; agentType?: string; model?: string; color?: string }>;
}

// List groups (project-scoped) --------------------------------------------
groupChatRoutes.get("/", (c) => {
  const projectPath = c.req.query("projectPath");
  if (!projectPath) return c.json(err("projectPath is required"), 400);
  return c.json(ok(listGroups(projectPath)));
});

// Create a group (+ members) ----------------------------------------------
groupChatRoutes.post("/", async (c) => {
  let body: CreateBody;
  try { body = await c.req.json(); } catch { return c.json(err("Invalid JSON body"), 400); }

  const { projectName, projectPath, name } = body;
  if (!projectName || !projectPath || !name) {
    return c.json(err("projectName, projectPath and name are required"), 400);
  }
  // Group name becomes a filesystem path segment for the transcript archive;
  // reject path separators / traversal / control chars to prevent escape.
  if (/[/\\]|\.\.|[\x00-\x1f]/.test(name)) {
    return c.json(err("group name must not contain path separators or control characters"), 400);
  }
  const members = body.members ?? [];
  if (!members.some((m) => m.role === "leader")) {
    return c.json(err("group must include exactly one leader"), 400);
  }

  const group = createGroup({ projectName, projectPath, name, maxTurns: body.maxTurns, maxCostUsd: body.maxCostUsd });
  for (const m of members) {
    if (!m.name || (m.role !== "leader" && m.role !== "member")) {
      return c.json(err("each member needs a name and a valid role"), 400);
    }
    const input: AddMemberInput = {
      groupId: group.id, role: m.role, name: m.name,
      persona: m.persona ?? null, agentType: m.agentType ?? null,
      model: m.model ?? null, color: m.color ?? null,
    };
    addMember(input);
  }
  return c.json(ok(group));
});

// Group detail + members ---------------------------------------------------
groupChatRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  const group = getGroup(id);
  if (!group) return c.json(err("Group not found"), 404);
  return c.json(ok({ ...group, members: listMembers(id) }));
});

// Group settings (reply-burst cap) -----------------------------------------
groupChatRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  let body: { maxTurns?: number };
  try { body = await c.req.json(); } catch { return c.json(err("Invalid JSON body"), 400); }
  if (body.maxTurns !== undefined) {
    const n = Math.floor(Number(body.maxTurns));
    if (!Number.isFinite(n) || n < 1 || n > 50) return c.json(err("maxTurns must be 1–50"), 400);
    setGroupMaxTurns(id, n);
  }
  return c.json(ok({ ...getGroup(id)!, members: listMembers(id) }));
});

// Member management (add / update / remove) -------------------------------
// Invariant: a group always has exactly one leader and at least one member.

groupChatRoutes.post("/:id/members", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);

  let body: { role?: string; name?: string; persona?: string; model?: string; color?: string };
  try { body = await c.req.json(); } catch { return c.json(err("Invalid JSON body"), 400); }
  const name = body.name?.trim();
  if (!name) return c.json(err("member name is required"), 400);
  const role = body.role === "leader" ? "leader" : "member";

  // Promoting a new leader demotes the current one (keep exactly one leader).
  if (role === "leader") {
    for (const m of listMembers(id)) {
      if (m.role === "leader") updateMember(m.id, { role: "member" });
    }
  }
  const input: AddMemberInput = {
    groupId: id, role, name,
    persona: body.persona ?? null, model: body.model ?? null, color: body.color ?? null,
  };
  return c.json(ok(addMember(input)));
});

groupChatRoutes.patch("/:id/members/:memberId", async (c) => {
  const id = c.req.param("id");
  const memberId = c.req.param("memberId");
  if (!VALID_GROUP_ID.test(id) || !VALID_MEMBER_ID.test(memberId)) return c.json(err("Invalid id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  const member = getMember(memberId);
  if (!member || member.groupId !== id) return c.json(err("Member not found"), 404);

  let body: { role?: string; name?: string; persona?: string; model?: string; color?: string };
  try { body = await c.req.json(); } catch { return c.json(err("Invalid JSON body"), 400); }

  const patch: UpdateMemberInput = {};
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return c.json(err("member name cannot be empty"), 400);
    patch.name = n;
  }
  if (body.persona !== undefined) patch.persona = body.persona || null;
  if (body.model !== undefined) patch.model = body.model || null;
  if (body.color !== undefined) patch.color = body.color || null;

  if (body.role !== undefined) {
    if (body.role !== "leader" && body.role !== "member") return c.json(err("invalid role"), 400);
    if (body.role === "leader") {
      // Demote the current leader(s) before promoting this member.
      for (const m of listMembers(id)) {
        if (m.role === "leader" && m.id !== memberId) updateMember(m.id, { role: "member" });
      }
      patch.role = "leader";
    } else if (member.role === "leader") {
      return c.json(err("promote another member to leader before demoting this one"), 400);
    }
  }
  return c.json(ok(updateMember(memberId, patch)));
});

groupChatRoutes.delete("/:id/members/:memberId", async (c) => {
  const id = c.req.param("id");
  const memberId = c.req.param("memberId");
  if (!VALID_GROUP_ID.test(id) || !VALID_MEMBER_ID.test(memberId)) return c.json(err("Invalid id"), 400);
  const group = getGroup(id);
  if (!group) return c.json(err("Group not found"), 404);
  const member = getMember(memberId);
  if (!member || member.groupId !== id) return c.json(err("Member not found"), 404);

  const members = listMembers(id);
  if (members.length <= 1) return c.json(err("a group needs at least one member"), 400);
  if (member.role === "leader") return c.json(err("reassign the leader before removing this member"), 400);
  await groupChatService.archiveMemberSession(group.name, member.sessionId);
  removeMember(memberId);
  return c.json(ok({ deleted: memberId }));
});

// Feed (windowed/paginated) ------------------------------------------------
groupChatRoutes.get("/:id/feed", (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);

  const limitRaw = c.req.query("limit");
  const sinceRaw = c.req.query("sinceTurn");
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 0)) : undefined;
  const sinceTurn = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
  const messages = readMessages(id, { limit, sinceTurn });
  return c.json(ok({ messages }));
});

// Archived transcript for a member session (powers "view full") — parsed into
// chat-style messages (text/thinking/tool_use/tool_result) + input config.
groupChatRoutes.get("/:id/transcript", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  const group = getGroup(id);
  if (!group) return c.json(err("Group not found"), 404);

  const sessionRef = c.req.query("sessionRef");
  if (!sessionRef || !VALID_SESSION_REF.test(sessionRef)) {
    return c.json(err("Invalid sessionRef"), 400);
  }
  const path = await resolveTranscriptPath(sessionRef, group.name);
  if (path === null) return c.json(err("Transcript not found"), 404);
  const [messages, config] = await Promise.all([
    parseJsonlTranscript(path),
    parseTranscriptConfig(path),
  ]);
  return c.json(ok({ messages, config }));
});

// Send a message → starts / feeds the engine ------------------------------
groupChatRoutes.post("/:id/message", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);

  let body: { content?: string };
  try { body = await c.req.json(); } catch { return c.json(err("Invalid JSON body"), 400); }
  const content = body.content?.trim();
  if (!content) return c.json(err("content is required"), 400);

  try {
    await groupChatService.start(id, content);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
  return c.json(ok({ started: true }));
});

// Stop / resume ------------------------------------------------------------
groupChatRoutes.post("/:id/stop", (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  groupChatService.stop(id);
  return c.json(ok({ status: "paused" }));
});

groupChatRoutes.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  try {
    await groupChatService.resume(id);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
  return c.json(ok({ status: "active" }));
});

// Delete -------------------------------------------------------------------
groupChatRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  // Archive member sessions (keep-alive means they live until now) BEFORE the store
  // cascade removes the member rows.
  await groupChatService.archiveAndForget(id);
  deleteGroup(id);
  return c.json(ok({ deleted: id }));
});
