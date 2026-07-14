import { api } from "./api-client";

export type AiResourceType = "skill" | "agent" | "command";
export type AiResourceScope = "project" | "user" | "bundled";
export type CreatableScope = "project" | "user";

export interface AiResourceItem {
  type: AiResourceType;
  name: string;
  description: string;
  scope: AiResourceScope;
  source: string;
  filePath: string;
  rootPath: string;
  argumentHint?: string;
  model?: string;
  tools?: string[];
  readOnly: boolean;
  shadowed: boolean;
  shadowedBy?: { name: string; source: string };
  overrides?: number;
}

export interface AiResourceGroup {
  type: AiResourceType;
  items: AiResourceItem[];
}

export interface AiResourceListResult {
  groups: AiResourceGroup[];
  stats: { active: number; project: number; user: number; bundled: number; shadowed: number };
}

const BASE = "/api/ai-resources";

export function listAiResources(project: string): Promise<AiResourceListResult> {
  return api.get<AiResourceListResult>(`${BASE}?project=${encodeURIComponent(project)}`);
}

export function readAiResource(path: string, project: string): Promise<{ content: string }> {
  return api.get<{ content: string }>(
    `${BASE}/content?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
  );
}

export function writeAiResource(path: string, content: string, project: string): Promise<boolean> {
  return api.put<boolean>(`${BASE}/content`, { path, content, project });
}

export function createAiResource(
  type: AiResourceType,
  scope: CreatableScope,
  name: string,
  project: string,
): Promise<{ filePath: string }> {
  return api.post<{ filePath: string }>(BASE, { type, scope, name, project });
}

export function duplicateAiResource(
  path: string,
  type: AiResourceType,
  scope: CreatableScope,
  name: string,
  project: string,
): Promise<{ filePath: string }> {
  return api.post<{ filePath: string }>(`${BASE}/duplicate`, { path, type, scope, name, project });
}

export function deleteAiResource(path: string, type: AiResourceType, project: string): Promise<void> {
  return api.del(BASE, { path, type, project });
}
