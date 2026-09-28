import { api, projectUrl } from "@/lib/api-client";
import type {
  DesignKind, DesignSnapshotInfo, DesignSummary, DesignSystemStatus,
} from "../../../shared/design-types";
import type { RestoreResult } from "../../../services/design/design-restore.service";

/**
 * The design REST surface (`/api/project/:name/designs`) and the canvas's preview-token
 * calls (`/api/design-preview`). Paths are built from a project name and a slug only; the
 * server derives every filesystem path itself.
 */

export interface DesignList {
  designs: DesignSummary[];
  system: DesignSystemStatus;
}

export interface DesignPreviewCapability {
  /** Path of the entry page, without the per-load `?n=` nonce. */
  url: string;
  token: string;
  expiresAt: number;
  /** True when a refresh handed back a successor token (and URL) for the next load. */
  rotated: boolean;
}

export interface DesignProvider {
  id: string;
  name: string;
  supportsDesignInstructions?: boolean;
}

const base = (projectName: string) => `${projectUrl(projectName)}/designs`;
const one = (projectName: string, slug: string) => `${base(projectName)}/${encodeURIComponent(slug)}`;

/** Normalised at the boundary: every caller renders `designs` straight into a list. */
export async function listDesigns(projectName: string): Promise<DesignList> {
  const data = await api.get<Partial<DesignList> | null>(base(projectName));
  return {
    designs: Array.isArray(data?.designs) ? data.designs : [],
    system: { designMd: !!data?.system?.designMd, tokensCss: !!data?.system?.tokensCss },
  };
}

export function getDesign(projectName: string, slug: string): Promise<DesignSummary> {
  return api.get<DesignSummary>(one(projectName, slug));
}

export function createDesign(projectName: string, input: { title: string; kind: DesignKind }): Promise<DesignSummary> {
  return api.post<DesignSummary>(base(projectName), input);
}

export function renameDesign(projectName: string, slug: string, title: string): Promise<DesignSummary> {
  return api.patch<DesignSummary>(one(projectName, slug), { title });
}

/** The server re-checks `confirm` against the slug, so a stray request cannot delete. */
export function deleteDesign(projectName: string, slug: string): Promise<void> {
  return api.del(`${one(projectName, slug)}?confirm=${encodeURIComponent(slug)}`);
}

export function listDesignHistory(projectName: string, slug: string): Promise<DesignSnapshotInfo[]> {
  return api.get<DesignSnapshotInfo[]>(`${one(projectName, slug)}/history`);
}

export function restoreDesignSnapshot(projectName: string, slug: string, id: string): Promise<RestoreResult> {
  return api.post<RestoreResult>(`${one(projectName, slug)}/history/${encodeURIComponent(id)}/restore`);
}

/** Mint a canvas token, or refresh `token` (which may hand back a rotated successor). */
export function requestCanvasPreview(projectName: string, slug: string, token?: string): Promise<DesignPreviewCapability> {
  return api.post<DesignPreviewCapability>("/api/design-preview", {
    projectName, slug, purpose: "canvas", ...(token ? { token } : {}),
  });
}

/** Providers that can host a design session: only they deliver the design instructions. */
export async function listDesignProviders(projectName: string): Promise<DesignProvider[]> {
  const providers = await api.get<DesignProvider[]>(`${projectUrl(projectName)}/chat/providers`);
  return providers.filter((p) => p.supportsDesignInstructions === true);
}
