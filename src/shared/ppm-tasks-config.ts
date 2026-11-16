/**
 * PPM Tasks: a project's configuration shapes (statuses, members, custom field definitions).
 * Re-exported by `ppm-tasks.ts`.
 */
import type { BaseGroup, ClosedAs } from "./ppm-tasks.ts";

export type FieldType = "text" | "number" | "select" | "date" | "link";
export const FIELD_TYPES: readonly FieldType[] = ["text", "number", "select", "date", "link"];

export interface TaskStatusDef {
  id: string;
  projectKey: string;
  name: string;
  baseGroup: BaseGroup;
  /** Set on closed statuses only. */
  closedAs: ClosedAs | null;
  position: number;
}

export interface TaskMember {
  id: string;
  projectKey: string;
  name: string;
  jiraAccountId: string | null;
  githubLogin: string | null;
  slackUserId: string | null;
  position: number;
  archivedAt: number | null;
}

export interface FieldDef {
  projectKey: string;
  key: string;
  label: string;
  type: FieldType;
  /** The choices of a `select` field; null for the other types. */
  options: string[] | null;
  position: number;
}
