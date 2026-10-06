import { Hono } from "hono";
import { resolve } from "node:path";
import { configService } from "../../services/config.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getDesignInstructions, setDesignInstructions } from "../../services/design/design-settings.service.ts";
import { listProviderSkills } from "../../services/design/design-skill-sources.ts";
import { installDesignSkill } from "../../services/design/design-skill-install.service.ts";
import type { DesignSkillRuntime } from "../../services/design/design-user-instructions.ts";
import { DESIGN_INSTRUCTIONS_MAX_BYTES, normalizeDesignInstructions } from "../../shared/design-skill-mentions.ts";
import type { SlashItem } from "../../services/slash-discovery/types.ts";
import { ok, err } from "../../types/api.ts";

/**
 * Settings → Design (`/api/settings/design`): the owner's global design instructions and,
 * for the editor's `/` picker, the skills each design-capable provider can load.
 */
export const designSettingsRoutes = new Hono();

interface ProviderSkillList {
  id: string;
  name: string;
  runtime: "claude" | "codex";
  items: SlashItem[];
  /**
   * Whether `items` is a real answer. An empty codex list is a runtime that did not answer
   * (codex always reports its own system skills when it is up), which the pane must not
   * present as "nothing installed"; an empty Claude list is just that.
   */
  available: boolean;
}

/** A registered project's folder by name; anything else lists user-level skills only. */
function projectPathByName(name: string | undefined): string | null {
  if (!name) return null;
  const project = configService.get("projects").find((p) => p.name === name);
  return project ? resolve(project.path) : null;
}

/** The registered providers that deliver design instructions: nothing else ever reads the setting. */
function designProviders() {
  return providerRegistry.listAll()
    .map(({ id }) => providerRegistry.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p?.supportsDesignInstructions);
}

/**
 * One list per design provider. A provider whose list cannot be read answers with an empty
 * one rather than failing the pane, which must still load the saved text.
 */
async function listDesignProviderSkills(projectPath: string | null, fresh: boolean): Promise<ProviderSkillList[]> {
  const providers = designProviders();
  return Promise.all(providers.map(async (provider): Promise<ProviderSkillList> => {
    try {
      const { runtime, items } = await listProviderSkills(provider.id, { projectPath, fresh });
      return { id: provider.id, name: provider.name, runtime, items, available: runtime === "claude" || items.length > 0 };
    } catch (e) {
      console.warn(`[design] could not list skills for ${provider.id}: ${(e as Error).message}`);
      return { id: provider.id, name: provider.name, runtime: provider.listSkills ? "codex" : "claude", items: [], available: false };
    }
  }));
}

/**
 * GET /settings/design?project=<name>&fresh=1 — `fresh` re-reads the skill lists (the
 * settings pane, opened right after installing a skill); without it the cached lists do.
 */
designSettingsRoutes.get("/", async (c) => {
  try {
    const fresh = c.req.query("fresh") === "1";
    const providers = await listDesignProviderSkills(projectPathByName(c.req.query("project")), fresh);
    return c.json(ok({ instructions: getDesignInstructions(), maxBytes: DESIGN_INSTRUCTIONS_MAX_BYTES, providers }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /settings/design — body: { instructions: string } */
designSettingsRoutes.put("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON"), 400);
  }
  const instructions = body && typeof body === "object" ? (body as { instructions?: unknown }).instructions : undefined;
  const result = normalizeDesignInstructions(instructions);
  if (!result.ok) return c.json(err(result.error), 400);
  try {
    setDesignInstructions(result.text);
    return c.json(ok({ instructions: result.text }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /settings/design/skill — install the suggested design skill for every runtime a design
 * chat can run on here (a provider with its own skill list is codex's, any other Claude's). The
 * request carries nothing: what is installed, and where, is the server's to decide.
 */
designSettingsRoutes.post("/skill", async (c) => {
  const runtimes = [...new Set(designProviders().map((p): DesignSkillRuntime => (p.listSkills ? "codex" : "claude")))];
  if (!runtimes.length) return c.json(err("No configured provider can run design chats"), 400);
  try {
    const results = await installDesignSkill(runtimes);
    // The skill's scripts are Python; the agent asks for it when it is missing, the pane says so now.
    const python = !!(Bun.which("python3") ?? Bun.which("python"));
    return c.json(ok({ results, python }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
