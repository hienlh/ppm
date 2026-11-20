import { configService } from "../config.service.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { VALID_PERMISSION_MODES, type PPMBotConfig } from "../../types/config.ts";
import { PPM_TOOLS, ppmToolOn } from "../../shared/ppm-tools.ts";
import {
  ASSISTANT_EFFORTS, ASSISTANT_INSTRUCTIONS_MAX_CHARS, MANAGER_MODES, type AssistantSettings,
} from "../../shared/assistant-settings.ts";
import { PERSONA_NAME_MAX_CHARS, PERSONA_SOUL_MAX_CHARS } from "../../shared/assistant-persona.ts";
import type { SettingEntry, WriteCall } from "./settings-catalog-types.ts";

/**
 * AI Provider, Tools, Accounts, PPM Assistant (its own settings and its Telegram bridge) and
 * Design. Provider rows are built per call from the providers configured now.
 */

const BOOL = { type: "boolean" } as const;
const EFFORT = { type: "enum", values: ASSISTANT_EFFORTS } as const;
const MODE_LABELS = {
  default: "Ask before risky tools", acceptEdits: "Accept edits", plan: "Plan first", bypassPermissions: "Bypass permissions — every tool runs unasked",
} as const;
const providerName = (id: string) => (id === "codex" ? "Codex" : id === "claude" ? "Claude" : id);

const PERMISSIONS = "It changes what chats may run without asking";
const TRUSTED_TEXT = "It is text every Assistant session trusts as the user's own";
const ASSISTANT_PERMISSIONS = "It changes what the Assistant itself may do";

/**
 * Keys the Assistant's settings route keeps as stored when a body leaves them out
 * (`saveAssistantSettings`). The rest — instructions, providers, MCP servers — must always be sent.
 */
const KEPT_WHEN_UNNAMED = [
  "digest", "quiet_hours", "timezone", "manager_default_mode", "manager_template", "restart_news", "persona",
  "auto_readonly_commands", "act_on_own", "permission_mode", "db_write_connections", "settings_tools", "main_session",
] as const;

/**
 * The Assistant's settings with one field changed. Its route replaces the object, so the fields it
 * requires are sent as stored; every field it keeps by itself is left out unless this change
 * touched it, so a switch flipped elsewhere meanwhile is not put back and nothing else is announced.
 */
function writeAssistant(change: (s: AssistantSettings) => void): WriteCall {
  const before = getAssistantSettings();
  const next = structuredClone(before) as unknown as Record<string, unknown>;
  change(next as unknown as AssistantSettings);
  const prior = before as unknown as Record<string, unknown>;
  for (const key of KEPT_WHEN_UNNAMED) {
    if (JSON.stringify(next[key]) === JSON.stringify(prior[key])) delete next[key];
  }
  return { method: "PUT", path: "/api/assistant/settings", body: next };
}

function providerRows(): SettingEntry[] {
  const providers = configService.get("ai").providers ?? {};
  return Object.keys(providers).flatMap((id): SettingEntry[] => {
    const at = (field: string) => (providers[id] as unknown as Record<string, unknown> | undefined)?.[field] ?? null;
    const put = (field: string) => (value: unknown): WriteCall => ({ method: "PUT", path: "/api/settings/ai", body: { providers: { [id]: { [field]: value } } } });
    return [
      {
        key: `ai.providers.${id}.model`, category: "ai-provider", label: `AI Provider → ${providerName(id)} → Model`, tier: "direct",
        value: { type: "text", maxLength: 120 }, read: () => at("model"), write: put("model"),
      },
      {
        key: `ai.providers.${id}.effort`, category: "ai-provider", label: `AI Provider → ${providerName(id)} → Effort`, tier: "direct",
        value: EFFORT, read: () => at("effort"), write: put("effort"),
      },
      {
        key: `ai.providers.${id}.permission_mode`, category: "ai-provider", label: `AI Provider → ${providerName(id)} → Execution mode`,
        tier: "card", cardReason: PERMISSIONS,
        value: { type: "enum", values: VALID_PERMISSION_MODES, labels: MODE_LABELS }, read: () => at("permission_mode") ?? "default", write: put("permission_mode"),
        warn: (v) => (v === "bypassPermissions" ? "New chats of this provider will run every tool without asking." : null),
      },
    ];
  });
}

function assistantProviderRows(): SettingEntry[] {
  return ["claude", "codex"].flatMap((id): SettingEntry[] => [
    {
      key: `assistant.providers.${id}.model`, category: "assistant", label: `PPM Assistant → ${providerName(id)} model`, tier: "direct",
      value: { type: "text", maxLength: 120 },
      read: () => getAssistantSettings().providers[id]?.model ?? null,
      write: (v) => writeAssistant((s) => { s.providers[id] = { ...s.providers[id], model: (v as string) || undefined }; }),
    },
    {
      key: `assistant.providers.${id}.effort`, category: "assistant", label: `PPM Assistant → ${providerName(id)} effort`, tier: "direct",
      value: EFFORT,
      read: () => getAssistantSettings().providers[id]?.effort ?? null,
      write: (v) => writeAssistant((s) => { s.providers[id] = { ...s.providers[id], effort: v as AssistantSettings["providers"][string]["effort"] }; }),
    },
  ]);
}

const clawbot = () => (configService.get("clawbot") ?? {}) as Partial<PPMBotConfig>;
const putClawbot = (field: string) => (value: unknown): WriteCall => ({ method: "PUT", path: "/api/settings/clawbot", body: { [field]: value } });

const STATIC_AI_SETTINGS: readonly SettingEntry[] = [
  {
    key: "ai.default_provider", category: "ai-provider", label: "AI Provider → Default provider for new chats", tier: "direct",
    value: { type: "enum", values: () => Object.keys(configService.get("ai").providers ?? {}) },
    read: () => configService.get("ai").default_provider,
    write: (v) => ({ method: "PUT", path: "/api/settings/ai", body: { default_provider: v } }),
  },
  {
    key: "ai.share_provider_context", category: "ai-provider", label: "AI Provider → Share instructions and memory between providers", tier: "direct",
    value: BOOL,
    read: () => configService.get("ai").share_provider_context === true,
    write: (v) => ({ method: "PUT", path: "/api/settings/ai", body: { share_provider_context: v } }),
  },
  ...PPM_TOOLS.map((tool): SettingEntry => ({
    key: `ai.ppm_tools.${tool}`, category: "tools", label: `Tools → ${tool}`, tier: "card", cardReason: PERMISSIONS,
    value: BOOL,
    read: () => ppmToolOn(configService.get("ai"), tool),
    write: (v) => ({ method: "PUT", path: "/api/settings/ai", body: { ppm_tools: { [tool]: v } } }),
  })),
  {
    key: "accounts.strategy", category: "accounts", label: "Accounts → Which Claude account a chat uses", tier: "card",
    cardReason: "It changes which account is charged",
    value: { type: "enum", values: ["round-robin", "fill-first", "lowest-usage"], labels: { "round-robin": "Take turns", "fill-first": "Use one until it is full", "lowest-usage": "The least used" } },
    read: async () => (await import("../account-selector.service.ts")).accountSelector.getStrategy(),
    write: (v) => ({ method: "PUT", path: "/api/accounts/settings", body: { strategy: v } }),
  },
  ...assistantRows(),
  {
    key: "assistant.telegram.enabled", category: "assistant", label: "PPM Assistant → Telegram bridge", tier: "card",
    cardReason: "Turning it off can cut the conversation you may be having on Telegram",
    value: BOOL, read: () => clawbot().enabled === true, write: putClawbot("enabled"),
    warn: (v) => (v === false ? "The Assistant stops answering on Telegram until it is switched back on in PPM." : null),
  },
  {
    key: "assistant.telegram.show_tool_calls", category: "assistant", label: "PPM Assistant → Telegram → Name the tools it ran", tier: "direct",
    value: BOOL, read: () => clawbot().show_tool_calls !== false, write: putClawbot("show_tool_calls"),
  },
  {
    key: "assistant.telegram.debounce_ms", category: "assistant", label: "PPM Assistant → Telegram → Join messages sent within", tier: "direct",
    value: { type: "int", min: 0, max: 30_000, unit: "ms" },
    read: () => (typeof clawbot().debounce_ms === "number" ? clawbot().debounce_ms : 2000), write: putClawbot("debounce_ms"),
  },
  {
    key: "assistant.telegram.quiet_while_in_ppm", category: "assistant", label: "PPM Assistant → Telegram → Quiet while I'm at PPM", tier: "direct",
    value: BOOL, read: () => clawbot().quiet_while_in_ppm !== false, write: putClawbot("quiet_while_in_ppm"),
  },
  {
    key: "design.instructions", category: "design", label: "Design → Instructions for design chats", tier: "card", cardReason: "It is text every design chat trusts as the user's own",
    value: { type: "text", maxLength: 16_000, multiline: true },
    read: async () => (await import("../design/design-settings.service.ts")).getDesignInstructions(),
    write: (v) => ({ method: "PUT", path: "/api/settings/design", body: { instructions: v } }),
  },
];

function assistantRows(): SettingEntry[] {
  const a = () => getAssistantSettings();
  const row = (key: string, label: string, entry: Pick<SettingEntry, "tier" | "value" | "cardReason" | "warn">, read: (s: AssistantSettings) => unknown, set: (s: AssistantSettings, v: unknown) => void): SettingEntry =>
    ({ key: `assistant.${key}`, category: "assistant", label: `PPM Assistant → ${label}`, ...entry, read: () => read(a()), write: (v) => writeAssistant((s) => set(s, v)) });
  const direct = (value: SettingEntry["value"]) => ({ tier: "direct" as const, value });
  const card = (value: SettingEntry["value"], cardReason: string) => ({ tier: "card" as const, value, cardReason });
  return [
    row("quiet_hours.enabled", "Quiet hours", direct(BOOL), (s) => s.quiet_hours.enabled, (s, v) => { s.quiet_hours.enabled = v as boolean; }),
    row("quiet_hours.start", "Quiet hours start", direct({ type: "time" }), (s) => s.quiet_hours.start, (s, v) => { s.quiet_hours.start = v as string; }),
    row("quiet_hours.end", "Quiet hours end", direct({ type: "time" }), (s) => s.quiet_hours.end, (s, v) => { s.quiet_hours.end = v as string; }),
    row("digest.enabled", "Morning digest", direct(BOOL), (s) => s.digest.enabled, (s, v) => { s.digest.enabled = v as boolean; }),
    row("digest.time", "Morning digest time", direct({ type: "time" }), (s) => s.digest.time, (s, v) => { s.digest.time = v as string; }),
    row("restart_news", "Tell me what happened while PPM restarted", direct(BOOL), (s) => s.restart_news, (s, v) => { s.restart_news = v as boolean; }),
    row("instructions", "Instructions", card({ type: "text", maxLength: ASSISTANT_INSTRUCTIONS_MAX_CHARS, multiline: true }, TRUSTED_TEXT), (s) => s.instructions, (s, v) => { s.instructions = v as string; }),
    row("persona.name", "Persona → Name", card({ type: "text", maxLength: PERSONA_NAME_MAX_CHARS }, TRUSTED_TEXT), (s) => s.persona.name, (s, v) => { s.persona.name = v as string; }),
    row("persona.soul", "Persona → Personality", card({ type: "text", maxLength: PERSONA_SOUL_MAX_CHARS, multiline: true }, TRUSTED_TEXT), (s) => s.persona.soul, (s, v) => { s.persona.soul = v as string; }),
    row("manager_template", "Template for new manager rules", card({ type: "text", maxLength: 32_000, multiline: true }, TRUSTED_TEXT), (s) => s.manager_template, (s, v) => { s.manager_template = v as string; }),
    row("permission_mode", "Permissions (Full or Ask)", card({ type: "enum", values: ["full", "ask"], labels: { full: "Full", ask: "Ask" } }, ASSISTANT_PERMISSIONS),
      (s) => s.permission_mode ?? null, (s, v) => { s.permission_mode = v as "full" | "ask"; }),
    row("act_on_own", "Let the Assistant act on its own", card(BOOL, ASSISTANT_PERMISSIONS), (s) => s.act_on_own, (s, v) => { s.act_on_own = v as boolean; }),
    row("auto_readonly_commands", "Run read-only commands without asking", card(BOOL, ASSISTANT_PERMISSIONS), (s) => s.auto_readonly_commands, (s, v) => { s.auto_readonly_commands = v as boolean; }),
    row("db_write_connections", "Connections it writes to without a card", card({ type: "id_list", maxItems: 100 }, ASSISTANT_PERMISSIONS), (s) => s.db_write_connections, (s, v) => { s.db_write_connections = v as number[]; }),
    row("manager_default_mode", "Mode new manager chats run in", card({ type: "enum", values: MANAGER_MODES, labels: MODE_LABELS }, PERMISSIONS),
      (s) => s.manager_default_mode, (s, v) => { s.manager_default_mode = v as AssistantSettings["manager_default_mode"]; }),
  ];
}

/** Every AI-area setting, provider rows included. */
export function aiSettings(): SettingEntry[] {
  return [...STATIC_AI_SETTINGS, ...providerRows(), ...assistantProviderRows()];
}
