import { api, projectUrl } from "@/lib/api-client";
import type {
  DesignPlatform, DesignSummary, DesignSystemStaleInfo, DesignSystemSummary,
} from "../../../shared/design-types";

/**
 * The declared-apps REST surface (`/api/project/:name/designs/systems`): list, declare, edit,
 * remove, its stale check, and getting-or-creating its showcase.
 */

const base = (projectName: string) => `${projectUrl(projectName)}/designs/systems`;
const one = (projectName: string, id: string) => `${base(projectName)}/${encodeURIComponent(id)}`;

export function listDesignSystems(projectName: string): Promise<DesignSystemSummary[]> {
  return api.get<DesignSystemSummary[]>(base(projectName));
}

export function getDesignSystem(projectName: string, id: string): Promise<DesignSystemSummary> {
  return api.get<DesignSystemSummary>(one(projectName, id));
}

export interface DesignSystemInput {
  id?: string;
  label: string;
  root: string;
  platform: DesignPlatform;
}

export function createDesignSystem(projectName: string, input: DesignSystemInput): Promise<DesignSystemSummary> {
  return api.post<DesignSystemSummary>(base(projectName), input);
}

export function updateDesignSystem(
  projectName: string, id: string, input: Partial<DesignSystemInput>,
): Promise<DesignSystemSummary> {
  return api.patch<DesignSystemSummary>(one(projectName, id), input);
}

export function deleteDesignSystem(projectName: string, id: string, deleteFiles: boolean): Promise<void> {
  return api.del(`${one(projectName, id)}?confirm=${encodeURIComponent(id)}${deleteFiles ? "&deleteFiles=1" : ""}`);
}

export function designSystemStaleness(projectName: string, id: string): Promise<DesignSystemStaleInfo> {
  return api.get<DesignSystemStaleInfo>(`${one(projectName, id)}/stale`);
}

export function ensureShowcaseDesign(projectName: string, id: string): Promise<DesignSummary> {
  return api.post<DesignSummary>(`${one(projectName, id)}/showcase`, {});
}
