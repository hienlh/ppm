import { api } from "@/lib/api-client";
import type { SlashItem } from "@/components/chat/slash-command-picker";

/** The skills one design-capable provider can load, as listed for the `/` picker. */
export interface DesignProviderSkills {
  id: string;
  name: string;
  runtime: "claude" | "codex";
  items: SlashItem[];
  /** False when the provider's list could not be read, so `items` says nothing. */
  available: boolean;
}

export interface DesignSettings {
  instructions: string;
  maxBytes: number;
  providers: DesignProviderSkills[];
}

/**
 * Settings → Design. `projectName` only widens the skill lists to that project's own
 * skills; the instructions themselves are global. `fresh` makes the server re-read the
 * skill lists instead of answering from its caches.
 */
export async function getDesignSettings(projectName?: string, opts: { fresh?: boolean } = {}): Promise<DesignSettings> {
  const query = new URLSearchParams();
  if (projectName) query.set("project", projectName);
  if (opts.fresh) query.set("fresh", "1");
  const qs = query.size > 0 ? `?${query}` : "";
  const data = await api.get<Partial<DesignSettings> | null>(`/api/settings/design${qs}`);
  return {
    instructions: typeof data?.instructions === "string" ? data.instructions : "",
    maxBytes: typeof data?.maxBytes === "number" ? data.maxBytes : 8 * 1024,
    providers: Array.isArray(data?.providers)
      ? data.providers.map((p) => ({ ...p, items: Array.isArray(p.items) ? p.items : [], available: p.available !== false }))
      : [],
  };
}

/** The lists that were actually read, for decisions that must not treat "unknown" as "none". */
export function readSkillLists(settings: DesignSettings): DesignProviderSkills["items"][] {
  return settings.providers.filter((p) => p.available).map((p) => p.items);
}

export async function saveDesignInstructions(instructions: string): Promise<string> {
  const data = await api.put<{ instructions: string }>("/api/settings/design", { instructions });
  return data.instructions;
}

export interface DesignSkillInstallResponse {
  results: Array<{ runtime: "claude" | "codex"; dir: string; installed: boolean; companions: string[] }>;
  /** Whether python3 (or python) is on the host's PATH — the skill's scripts need it. */
  python: boolean;
}

/** Install the suggested design skill for every design runtime the host has. */
export async function installDesignSkill(): Promise<DesignSkillInstallResponse> {
  return api.post<DesignSkillInstallResponse>("/api/settings/design/skill");
}
