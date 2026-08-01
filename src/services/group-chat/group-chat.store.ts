import { randomUUID } from "node:crypto";
import { getDb } from "../db.service.ts";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_COST_USD,
  type Group,
  type GroupMember,
  type GroupMessage,
  type GroupStatus,
  type MemberStatus,
  type CreateGroupInput,
  type AddMemberInput,
  type UpdateMemberInput,
  type AppendMessageInput,
  type ReadMessagesOptions,
} from "../../types/group-chat.ts";

interface GroupRow {
  id: string;
  project_name: string;
  project_path: string;
  name: string;
  leader_session_id: string | null;
  status: GroupStatus;
  max_turns: number;
  max_cost_usd: number;
  created_at: number;
}

interface MemberRow {
  id: string;
  group_id: string;
  role: "leader" | "member";
  persona: string | null;
  agent_type: string | null;
  model: string | null;
  session_id: string | null;
  name: string;
  color: string | null;
  status: MemberStatus;
  joined_at: number;
}

interface MessageRow {
  seq: number;
  id: string;
  group_id: string;
  from_member: string;
  to_member: string | null;
  kind: GroupMessage["kind"];
  summary: string | null;
  full_session_ref: string | null;
  data: string | null;
  turn_index: number;
  created_at: number;
}

function toGroup(r: GroupRow): Group {
  return {
    id: r.id,
    projectName: r.project_name,
    projectPath: r.project_path,
    name: r.name,
    leaderSessionId: r.leader_session_id,
    status: r.status,
    maxTurns: r.max_turns,
    maxCostUsd: r.max_cost_usd,
    createdAt: r.created_at,
  };
}

function toMember(r: MemberRow): GroupMember {
  return {
    id: r.id,
    groupId: r.group_id,
    role: r.role,
    persona: r.persona,
    agentType: r.agent_type,
    model: r.model,
    sessionId: r.session_id,
    name: r.name,
    color: r.color,
    status: r.status,
    joinedAt: r.joined_at,
  };
}

function toMessage(r: MessageRow): GroupMessage {
  let data: unknown = null;
  if (r.data != null) {
    try { data = JSON.parse(r.data); } catch { data = null; }
  }
  return {
    id: r.id,
    groupId: r.group_id,
    fromMember: r.from_member,
    toMember: r.to_member,
    kind: r.kind,
    summary: r.summary,
    fullSessionRef: r.full_session_ref,
    data,
    turnIndex: r.turn_index,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function createGroup(input: CreateGroupInput): Group {
  const id = randomUUID();
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  getDb().query(
    `INSERT INTO chat_groups (id, project_name, project_path, name, status, max_turns, max_cost_usd)
     VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(id, input.projectName, input.projectPath, input.name, maxTurns, maxCostUsd);
  return getGroup(id)!;
}

export function getGroup(id: string): Group | null {
  const row = getDb().query("SELECT * FROM chat_groups WHERE id = ?").get(id) as GroupRow | null;
  return row ? toGroup(row) : null;
}

export function listGroups(projectPath: string): Group[] {
  const rows = getDb().query(
    "SELECT * FROM chat_groups WHERE project_path = ? ORDER BY created_at DESC, id",
  ).all(projectPath) as GroupRow[];
  return rows.map(toGroup);
}

export function deleteGroup(id: string): void {
  getDb().query("DELETE FROM chat_groups WHERE id = ?").run(id);
}

export function setGroupStatus(id: string, status: GroupStatus): void {
  getDb().query("UPDATE chat_groups SET status = ? WHERE id = ?").run(status, id);
}

export function setGroupLeaderSession(id: string, sessionId: string): void {
  getDb().query("UPDATE chat_groups SET leader_session_id = ? WHERE id = ?").run(sessionId, id);
}

/** Update the per-group reply-burst cap (max AI turns per user message). */
export function setGroupMaxTurns(id: string, maxTurns: number): void {
  getDb().query("UPDATE chat_groups SET max_turns = ? WHERE id = ?").run(maxTurns, id);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function addMember(input: AddMemberInput): GroupMember {
  const id = randomUUID();
  getDb().query(
    `INSERT INTO chat_group_members (id, group_id, role, persona, agent_type, model, name, color, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
  ).run(
    id, input.groupId, input.role, input.persona ?? null, input.agentType ?? null,
    input.model ?? null, input.name, input.color ?? null,
  );
  const row = getDb().query("SELECT * FROM chat_group_members WHERE id = ?").get(id) as MemberRow;
  return toMember(row);
}

export function getMember(memberId: string): GroupMember | null {
  const row = getDb().query("SELECT * FROM chat_group_members WHERE id = ?").get(memberId) as MemberRow | null;
  return row ? toMember(row) : null;
}

/** Update the provided fields of a member; unspecified fields are left unchanged. */
export function updateMember(memberId: string, patch: UpdateMemberInput): GroupMember | null {
  const cols: Array<[string, string | null]> = [];
  if (patch.role !== undefined) cols.push(["role", patch.role]);
  if (patch.name !== undefined) cols.push(["name", patch.name]);
  if (patch.persona !== undefined) cols.push(["persona", patch.persona]);
  if (patch.agentType !== undefined) cols.push(["agent_type", patch.agentType]);
  if (patch.model !== undefined) cols.push(["model", patch.model]);
  if (patch.color !== undefined) cols.push(["color", patch.color]);
  if (cols.length === 0) return getMember(memberId);
  const set = cols.map(([c]) => `${c} = ?`).join(", ");
  getDb().query(`UPDATE chat_group_members SET ${set} WHERE id = ?`).run(...cols.map(([, v]) => v), memberId);
  return getMember(memberId);
}

export function removeMember(memberId: string): void {
  getDb().query("DELETE FROM chat_group_members WHERE id = ?").run(memberId);
}

export function listMembers(groupId: string): GroupMember[] {
  const rows = getDb().query(
    "SELECT * FROM chat_group_members WHERE group_id = ? ORDER BY joined_at, id",
  ).all(groupId) as MemberRow[];
  return rows.map(toMember);
}

export function setMemberSession(memberId: string, sessionId: string): void {
  getDb().query("UPDATE chat_group_members SET session_id = ? WHERE id = ?").run(sessionId, memberId);
}

export function setMemberStatus(memberId: string, status: MemberStatus): void {
  getDb().query("UPDATE chat_group_members SET status = ? WHERE id = ?").run(status, memberId);
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------

export function appendMessage(input: AppendMessageInput): GroupMessage {
  const id = randomUUID();
  const data = input.data === undefined ? null : JSON.stringify(input.data);
  getDb().query(
    `INSERT INTO chat_group_messages
       (id, group_id, from_member, to_member, kind, summary, full_session_ref, data, turn_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.groupId, input.fromMember, input.toMember ?? null, input.kind,
    input.summary ?? null, input.fullSessionRef ?? null, data, input.turnIndex,
  );
  const row = getDb().query("SELECT * FROM chat_group_messages WHERE id = ?").get(id) as MessageRow;
  return toMessage(row);
}

/** Read bus messages ascending by (created_at, id). `limit` returns the last-N;
 *  `sinceTurn` returns only messages with turn_index > sinceTurn. */
export function readMessages(groupId: string, opts: ReadMessagesOptions = {}): GroupMessage[] {
  const clauses = ["group_id = ?"];
  const params: (string | number)[] = [groupId];
  if (opts.sinceTurn !== undefined) {
    clauses.push("turn_index > ?");
    params.push(opts.sinceTurn);
  }
  const where = clauses.join(" AND ");

  if (opts.limit !== undefined) {
    // Last-N: order DESC + limit, then reverse to ascending.
    const rows = getDb().query(
      `SELECT * FROM chat_group_messages WHERE ${where} ORDER BY seq DESC LIMIT ?`,
    ).all(...params, opts.limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  const rows = getDb().query(
    `SELECT * FROM chat_group_messages WHERE ${where} ORDER BY seq ASC`,
  ).all(...params) as MessageRow[];
  return rows.map(toMessage);
}
