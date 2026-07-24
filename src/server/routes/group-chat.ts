import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  createGroup,
  getGroup,
  listGroups,
  deleteGroup,
  addMember,
  listMembers,
  readMessages,
} from "../../services/group-chat/group-chat.store.ts";
import { groupChatService } from "../../services/group-chat/group-chat.service.ts";
import type { AddMemberInput } from "../../types/group-chat.ts";

/** Allowlist: group ids are UUIDs — alphanumeric + hyphens only. */
const VALID_GROUP_ID = /^[a-zA-Z0-9-]+$/;

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

groupChatRoutes.post("/:id/resume", (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  groupChatService.resume(id);
  return c.json(ok({ status: "active" }));
});

// Delete -------------------------------------------------------------------
groupChatRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  if (!VALID_GROUP_ID.test(id)) return c.json(err("Invalid group id"), 400);
  if (!getGroup(id)) return c.json(err("Group not found"), 404);
  groupChatService.stop(id);
  deleteGroup(id);
  return c.json(ok({ deleted: id }));
});
