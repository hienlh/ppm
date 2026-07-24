import { api } from "@/lib/api-client";
import type { Group, GroupMember, GroupMessage, MemberRole } from "../../types/group-chat";

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

/** Raw archived transcript JSONL for a member session (powers "view full").
 *  Backend endpoint tracked for Phase 6 — surfaced as a friendly message if 404. */
export function getTranscript(id: string, sessionRef: string): Promise<{ content: string }> {
  return api.get<{ content: string }>(
    `${BASE}/${encodeURIComponent(id)}/transcript?sessionRef=${encodeURIComponent(sessionRef)}`,
  );
}
