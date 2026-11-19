import { Hono } from "hono";
import { providerRegistry } from "../../providers/registry.ts";
import { assistantSettingsView, saveAssistantSettings } from "../../services/assistant/assistant-settings.service.ts";
import { ASSISTANT_INSTRUCTIONS_MAX_CHARS, ASSISTANT_MCP_MAX_SERVERS } from "../../shared/assistant-settings.ts";
import { RULES_FILE_MAX_BYTES } from "../../shared/assistant-limits.ts";
import { DEFAULT_MANAGER_RULES_TEMPLATE } from "../../services/assistant-managers/manager-rules-default-template.ts";
import { createLogger } from "../../services/logger.ts";
import { assistantTelegramRoutes } from "./assistant-telegram.ts";
import { assistantManagerRoutes } from "./assistant-managers.ts";
import { assistantCardRoutes } from "./assistant-cards.ts";
import { assistantNotesRoutes } from "./assistant-notes.ts";
import { ok, err } from "../../types/api.ts";
import { settleFeaturesDecidedInSettings } from "../../services/feature-intros.service.ts";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";

/** Counts and names only: a server's settings carry secrets. */
const log = createLogger("assistant-settings");

/**
 * Settings → PPM Assistant (`/api/assistant/settings`), behind PPM's auth. Env and header values
 * of the Assistant's MCP servers never leave the server: GET blanks them, and PUT takes a blank
 * as "keep the saved value".
 */
export const assistantSettingsRoutes = new Hono();

assistantSettingsRoutes.route("/telegram", assistantTelegramRoutes);
assistantSettingsRoutes.route("/", assistantManagerRoutes);
assistantSettingsRoutes.route("/", assistantCardRoutes);
assistantSettingsRoutes.route("/", assistantNotesRoutes);

/** Registered providers that can run an Assistant session. */
function assistantProviders(): Array<{ id: string; name: string }> {
  return providerRegistry.listAll()
    .map(({ id }) => providerRegistry.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p?.supportsAssistantSessions)
    .map((p) => ({ id: p.id, name: p.name }));
}

function payload() {
  return {
    settings: assistantSettingsView(),
    providers: assistantProviders(),
    limits: {
      instructionsMaxChars: ASSISTANT_INSTRUCTIONS_MAX_CHARS,
      maxServers: ASSISTANT_MCP_MAX_SERVERS,
      managerTemplateMaxBytes: RULES_FILE_MAX_BYTES,
    },
    /** What a new manager's rules start as while `manager_template` is empty. */
    managerTemplateBuiltIn: DEFAULT_MANAGER_RULES_TEMPLATE,
  };
}

assistantSettingsRoutes.get("/settings", (c) => {
  try {
    return c.json(ok(payload()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantSettingsRoutes.put("/settings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON"), 400);
  }
  try {
    const supported = new Set(assistantProviders().map((p) => p.id));
    const result = saveAssistantSettings(body, (id) => supported.has(id));
    if (!result.ok) return c.json(err(result.errors.join("; ")), 400);
    log.info(`Saved: ${result.settings.mcp_servers.length} MCP server(s): ${result.settings.mcp_servers.map((s) => s.name).join(", ") || "none"}`);
    // Choosing Full or Ask here answers the "PPM has new features" question for it on every device.
    const named = typeof body === "object" && body !== null && "permission_mode" in body;
    if (named) {
      log.info(`Permission mode: ${result.settings.permission_mode ?? "not chosen"}`);
      if (settleFeaturesDecidedInSettings()) broadcastGlobalEvent({ type: FEATURE_INTROS_CHANGED_EVENT, change: "settings" });
    }
    return c.json(ok(payload()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
