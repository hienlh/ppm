import { randomUUID } from "node:crypto";
import { configService } from "../config.service.ts";
import {
  maskAssistantSettings, readAssistantSettings,
  type AssistantMcpServer, type AssistantProviderDefaults, type AssistantSettings, type AssistantSettingsView,
} from "../../shared/assistant-settings.ts";

/**
 * Settings → PPM Assistant, as stored in the `assistant` config row. Read fresh on every call:
 * the settings apply from the next turn, and a cached copy would outlive a save.
 */
export function getAssistantSettings(): AssistantSettings {
  // A stored row only ever comes from `saveAssistantSettings`, so anything invalid in it is
  // dropped rather than reported.
  return readAssistantSettings(configService.get("assistant") ?? {}).value;
}

/** What a browser may see: every MCP env and header value blanked. */
export function assistantSettingsView(): AssistantSettingsView {
  return maskAssistantSettings(getAssistantSettings());
}

/** The model and effort a new Assistant session on this provider starts with. */
export function assistantProviderDefaults(providerId: string): AssistantProviderDefaults {
  return getAssistantSettings().providers[providerId] ?? {};
}

/** The servers an Assistant session runs with, secrets included. Server-side only. */
export function enabledAssistantMcpServers(): AssistantMcpServer[] {
  return getAssistantSettings().mcp_servers.filter((s) => s.enabled);
}

/** Whether two stored URLs (both validated as http/https on the way in) share scheme, host and port. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export type SaveAssistantSettingsResult =
  | { ok: true; settings: AssistantSettingsView }
  | { ok: false; errors: string[] };

/**
 * Validate and store settings sent from the pane. A blank env or header value means "keep the
 * saved one": the pane never has it to send back. Its server is found by id, so a rename keeps
 * its secrets; a blank for a key that has no saved value is an error rather than an empty secret.
 * `isProvider` decides which default provider is acceptable.
 */
export function saveAssistantSettings(input: unknown, isProvider: (id: string) => boolean): SaveAssistantSettingsResult {
  const { value, errors } = readAssistantSettings(input);
  if (value.default_provider && !isProvider(value.default_provider)) {
    errors.push(`"${value.default_provider}" cannot run PPM Assistant sessions`);
  }
  const stored = new Map(getAssistantSettings().mcp_servers.map((s) => [s.id, s]));
  const usedIds = new Set<string>();
  const servers = value.mcp_servers.map((server): AssistantMcpServer => {
    const previous = server.id ? stored.get(server.id) : undefined;
    const id = previous && !usedIds.has(server.id) ? server.id : randomUUID();
    usedIds.add(id);
    const kept = previous?.transport === server.transport ? previous : undefined;
    const fill = (pairs: Record<string, string>, saved: Record<string, string> | undefined, what: string, why = "") => {
      const out: Record<string, string> = {};
      for (const [key, val] of Object.entries(pairs)) {
        if (val) out[key] = val;
        else if (saved && Object.hasOwn(saved, key)) out[key] = saved[key]!;
        else errors.push(`MCP server "${server.name}": ${what} ${key} needs a value${why}`);
      }
      return out;
    };
    if (server.transport === "stdio") {
      return { ...server, id, env: fill(server.env, kept?.transport === "stdio" ? kept.env : undefined, "variable") };
    }
    // A header saved for one server is not sent to another: a URL moved to a different origin
    // takes its headers only as typed again, the way ntfy drops its token for a new server.
    const savedHeaders = kept?.transport === "http" && sameOrigin(kept.url, server.url) ? kept.headers : undefined;
    const moved = kept?.transport === "http" && !savedHeaders ? " (the URL now points at a different server, so the saved value is not reused)" : "";
    return { ...server, id, headers: fill(server.headers, savedHeaders, "header", moved) };
  });
  if (errors.length > 0) return { ok: false, errors };
  const next: AssistantSettings = { ...value, mcp_servers: servers };
  configService.set("assistant", next);
  return { ok: true, settings: maskAssistantSettings(next) };
}
