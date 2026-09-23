import { api, getAuthToken, projectUrl } from "@/lib/api-client";
import type { TweakDef } from "../../../shared/design-tweaks";

/**
 * `/api/project/:name/designs/:slug/tweaks`. The commit carries variable names and values
 * only; the server decides which declaration each one lands in.
 *
 * The commit does its own fetch (like `fs-api.ts`) because a stale gen is an expected
 * answer, not a failure: the shared client turns every non-ok body into a bare `Error` and
 * would drop the file and gen the 409 names.
 */

export interface DesignTweaksInfo {
  manifestValid: boolean;
  tweaks: TweakDef[];
  errors: string[];
}

export type TweakCommitOutcome =
  | { status: "applied"; gens: Record<string, string> }
  | { status: "stale"; file: string; currentGen: string };

const base = (projectName: string, slug: string) =>
  `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}/tweaks`;

/** Normalised at the boundary, so the panel can render whatever comes back. */
export async function getDesignTweaks(projectName: string, slug: string): Promise<DesignTweaksInfo> {
  const data = await api.get<Partial<DesignTweaksInfo> | null>(base(projectName, slug));
  return {
    manifestValid: data?.manifestValid === true,
    tweaks: Array.isArray(data?.tweaks) ? data.tweaks : [],
    errors: Array.isArray(data?.errors) ? data.errors.filter((e): e is string => typeof e === "string") : [],
  };
}

export async function commitDesignTweaks(
  projectName: string,
  slug: string,
  body: { entry: string; gens: Record<string, string>; values: Record<string, string> },
): Promise<TweakCommitOutcome> {
  const token = getAuthToken();
  const res = await fetch(base(projectName, slug), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: { ok?: boolean; error?: string; data?: Record<string, unknown> };
  try {
    json = await res.json();
  } catch {
    throw new Error(`Server error (HTTP ${res.status})`);
  }
  if (res.status === 409 && typeof json.data?.file === "string" && typeof json.data.currentGen === "string") {
    return { status: "stale", file: json.data.file, currentGen: json.data.currentGen };
  }
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  const gens = json.data?.gens;
  return { status: "applied", gens: gens && typeof gens === "object" ? (gens as Record<string, string>) : {} };
}
