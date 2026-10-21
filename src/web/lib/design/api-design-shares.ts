import { api, projectUrl } from "@/lib/api-client";
import type {
  CreateDesignShareInput, DesignShareAddress, DesignShareChangedFiles, DesignShareLink, UpdateDesignShareInput,
  UpdateDesignShareResult,
} from "../../../shared/design-share-types";

/**
 * The owner's share links of one design (`/api/project/:name/designs/:slug/shares`) and the
 * public address they are reachable at (`/api/design-shares/address`). Every link carries
 * only its `/s/<code>` path; the full URL is built at display time from the address.
 */

const base = (projectName: string, slug: string) =>
  `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}/shares`;

/** Normalised at the boundary: callers render the list straight away. */
export async function listDesignShares(projectName: string, slug: string): Promise<DesignShareLink[]> {
  const data = await api.get<{ links?: DesignShareLink[] } | null>(base(projectName, slug));
  return Array.isArray(data?.links) ? data.links : [];
}

export async function createDesignShare(projectName: string, slug: string, input: CreateDesignShareInput): Promise<DesignShareLink> {
  const data = await api.post<{ link: DesignShareLink }>(base(projectName, slug), input);
  return data.link;
}

export function updateDesignShare(
  projectName: string, slug: string, id: string, patch: UpdateDesignShareInput,
): Promise<UpdateDesignShareResult> {
  return api.patch<UpdateDesignShareResult>(`${base(projectName, slug)}/${encodeURIComponent(id)}`, patch);
}

/** What "Update to latest" would change, before it is done; null when the pinned version is gone. */
export async function previewDesignShareRepin(projectName: string, slug: string, id: string): Promise<DesignShareChangedFiles | null> {
  const data = await api.get<{ changedFiles?: DesignShareChangedFiles | null } | null>(
    `${base(projectName, slug)}/${encodeURIComponent(id)}/changes`,
  );
  return data?.changedFiles ?? null;
}

export function deleteDesignShare(projectName: string, slug: string, id: string): Promise<void> {
  return api.del(`${base(projectName, slug)}/${encodeURIComponent(id)}`);
}

export function getDesignShareAddress(): Promise<DesignShareAddress> {
  return api.get<DesignShareAddress>("/api/design-shares/address");
}
