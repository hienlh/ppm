import { api } from "@/lib/api-client";
import type { Group, GroupMember, GroupMessage, MemberRole } from "../../types/group-chat";
import type { ChatMessage } from "../../types/chat";

const BASE = "/api/group-chat";

/** A group with its members (shape returned by GET /:id). */
export interface GroupDetail extends Group {
  members: GroupMember[];
}

/** One member entry when creating a group. */
export interface CreateMemberInput {
  role: MemberRole;
  name: string;
  persona?: string | null;
  model?: string | null;
  color?: string | null;
}

export interface CreateGroupBody {
  projectName: string;
  projectPath: string;
  name: string;
  maxTurns?: number;
  maxCostUsd?: number;
  members: CreateMemberInput[];
}

/** List all groups for a project (scoped by absolute project path). */
export function listGroups(projectPath: string): Promise<Group[]> {
  return api.get<Group[]>(`${BASE}?projectPath=${encodeURIComponent(projectPath)}`);
}

/** Fetch a single group plus its roster. */
export function getGroup(id: string): Promise<GroupDetail> {
  return api.get<GroupDetail>(`${BASE}/${encodeURIComponent(id)}`);
}

/** Create a group with its member roster (exactly one leader required). */
export function createGroup(body: CreateGroupBody): Promise<Group> {
  return api.post<Group>(BASE, body);
}

/** Update per-group settings (currently the reply-burst cap `maxTurns`, 1–50). */
export function updateGroupSettings(id: string, patch: { maxTurns?: number }): Promise<GroupDetail> {
  return api.patch<GroupDetail>(`${BASE}/${encodeURIComponent(id)}`, patch);
}

/** Windowed feed for a group. */
export function getFeed(
  id: string,
  opts?: { limit?: number; sinceTurn?: number },
): Promise<{ messages: GroupMessage[] }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.sinceTurn != null) params.set("sinceTurn", String(opts.sinceTurn));
  const qs = params.toString();
  return api.get<{ messages: GroupMessage[] }>(`${BASE}/${encodeURIComponent(id)}/feed${qs ? `?${qs}` : ""}`);
}

/** Send a message to the group (starts / feeds the engine). */
export function sendGroupMessage(id: string, content: string): Promise<{ started: boolean }> {
  return api.post<{ started: boolean }>(`${BASE}/${encodeURIComponent(id)}/message`, { content });
}

export function stopGroup(id: string): Promise<{ status: string }> {
  return api.post<{ status: string }>(`${BASE}/${encodeURIComponent(id)}/stop`);
}

export function resumeGroup(id: string): Promise<{ status: string }> {
  return api.post<{ status: string }>(`${BASE}/${encodeURIComponent(id)}/resume`);
}

export function deleteGroup(id: string): Promise<void> {
  return api.del(`${BASE}/${encodeURIComponent(id)}`);
}

/** Member management (post-creation). */
export interface MemberPatch {
  role?: MemberRole;
  name?: string;
  persona?: string | null;
  model?: string | null;
  color?: string | null;
}

export function addGroupMember(
  id: string,
  member: { name: string; role?: MemberRole; persona?: string | null; model?: string | null; color?: string | null },
): Promise<GroupMember> {
  return api.post<GroupMember>(`${BASE}/${encodeURIComponent(id)}/members`, member);
}

export function updateGroupMember(id: string, memberId: string, patch: MemberPatch): Promise<GroupMember> {
  return api.patch<GroupMember>(`${BASE}/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`, patch);
}

export function removeGroupMember(id: string, memberId: string): Promise<void> {
  return api.del(`${BASE}/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`);
}

/** Parsed archived transcript for a member session (powers "view full") — chat-style
 *  messages (text/thinking/tool_use/tool_result) plus the session input config. */
export function getTranscript(id: string, sessionRef: string): Promise<TranscriptResult> {
  return api.get<TranscriptResult>(
    `${BASE}/${encodeURIComponent(id)}/transcript?sessionRef=${encodeURIComponent(sessionRef)}`,
  );
}

export interface TranscriptConfig {
  model?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  permissionMode?: string;
}

export interface TranscriptResult {
  messages: ChatMessage[];
  config: TranscriptConfig | null;
}
