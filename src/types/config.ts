export interface PushConfig {
  vapid_public_key: string;
  vapid_private_key: string;
  vapid_subject: string;
}

export interface TelegramConfig {
  bot_token: string;
}

export interface PPMBotConfig {
  enabled: boolean;
  default_provider: string;
  default_project: string;
  system_prompt: string;
  show_tool_calls: boolean;
  show_thinking: boolean;
  permission_mode: string;
  debounce_ms: number;
}

export type ThemeConfig = "light" | "dark" | "system";

export interface PpmConfig {
  device_name: string;
  port: number;
  host: string;
  theme: ThemeConfig;
  auth: AuthConfig;
  projects: ProjectConfig[];
  ai: AIConfig;
  push?: PushConfig;
  telegram?: TelegramConfig;
  clawbot?: PPMBotConfig;
  cloud_url?: string;
}

export interface AuthConfig {
  enabled: boolean;
  token: string;
}

export interface ProjectConfig {
  path: string;
  name: string;
  color?: string;
}

export interface AIConfig {
  default_provider: string;
  providers: Record<string, AIProviderConfig>;
}

const VALID_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type PermissionMode = typeof VALID_PERMISSION_MODES[number];

export interface AIProviderConfig {
  type: "agent-sdk" | "cli" | "mock";

  // Common fields (all providers)
  permission_mode?: PermissionMode;
  system_prompt?: string;
  model?: string;

  // SDK-specific (Claude)
  api_key_env?: string;
  api_key?: string;
  base_url?: string;
  effort?: "low" | "medium" | "high" | "max";
  max_turns?: number;
  max_budget_usd?: number;
  thinking_budget_tokens?: number;
  agent_teams?: boolean;

  // CLI-specific (Cursor, Codex, Gemini)
  cli_command?: string;
}

export const DEFAULT_CONFIG: PpmConfig = {
  device_name: "",
  port: 8080,
  host: "0.0.0.0",
  theme: "system",
  auth: { enabled: true, token: "" },
  projects: [],
  ai: {
    default_provider: "claude",
    providers: {
      claude: {
        type: "agent-sdk",
        api_key_env: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-6",
        effort: "high",
        max_turns: 100,
        permission_mode: "bypassPermissions",
      },
    },
  },
  telegram: {
    bot_token: "",
  },
  clawbot: {
    enabled: false,
    default_provider: "claude",
    default_project: "",
    system_prompt: "You are PPMBot, a helpful AI coding assistant on Telegram. Keep responses concise and mobile-friendly. Use short paragraphs. When showing code, use compact examples. Be direct and helpful.",
    show_tool_calls: true,
    show_thinking: false,
    permission_mode: "bypassPermissions",
    debounce_ms: 2000,
  },
};

const VALID_TYPES = ["agent-sdk", "cli", "mock"] as const;
const VALID_EFFORTS = ["low", "medium", "high"] as const;
const VALID_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"] as const;
/** Allowed CLI commands for CLI providers (prevents command injection) */
const VALID_CLI_COMMANDS = ["cursor-agent", "codex", "gemini"] as const;
/** Only these values are allowed for default_provider in config */
export const VALID_PROVIDERS = ["claude", "cursor"] as const;
const VALID_THEMES: ThemeConfig[] = ["light", "dark", "system"];

/** Validate AI provider config fields. Returns array of error messages (empty = valid). */
export function validateAIProviderConfig(config: Partial<AIProviderConfig>): string[] {
  const errors: string[] = [];
  if (config.type != null && !VALID_TYPES.includes(config.type as any)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(", ")}`);
  }

  // CLI-specific validation
  if (config.type === "cli") {
    if (!config.cli_command) {
      errors.push("cli_command is required for CLI providers");
    } else if (!VALID_CLI_COMMANDS.includes(config.cli_command as any)) {
      errors.push(`cli_command must be one of: ${VALID_CLI_COMMANDS.join(", ")}`);
    }
    // CLI providers accept any model string — skip VALID_MODELS check
  } else {
    // SDK/mock model validation
    if (config.model != null && !VALID_MODELS.includes(config.model as any)) {
      errors.push(`model must be one of: ${VALID_MODELS.join(", ")}`);
    }
  }

  if (config.effort && !VALID_EFFORTS.includes(config.effort as any)) {
    errors.push(`effort must be one of: ${VALID_EFFORTS.join(", ")}`);
  }
  if (config.max_turns != null && (!Number.isInteger(config.max_turns) || config.max_turns < 1 || config.max_turns > 500)) {
    errors.push("max_turns must be integer 1-500");
  }
  if (config.max_budget_usd != null && (config.max_budget_usd < 0.01 || config.max_budget_usd > 50)) {
    errors.push("max_budget_usd must be 0.01-50.00");
  }
  if (config.thinking_budget_tokens != null && (!Number.isInteger(config.thinking_budget_tokens) || config.thinking_budget_tokens < 0)) {
    errors.push("thinking_budget_tokens must be integer >= 0");
  }
  if (config.permission_mode != null && !VALID_PERMISSION_MODES.includes(config.permission_mode as any)) {
    errors.push(`permission_mode must be one of: ${VALID_PERMISSION_MODES.join(", ")}`);
  }
  if (config.base_url != null) {
    if (typeof config.base_url !== "string") {
      errors.push("base_url must be a string");
    } else if (config.base_url && !/^https?:\/\/.+/.test(config.base_url)) {
      errors.push("base_url must be a valid HTTP(S) URL");
    }
  }
  if (config.system_prompt != null) {
    if (typeof config.system_prompt !== "string") {
      errors.push("system_prompt must be a string");
    } else if (config.system_prompt.length > 10000) {
      errors.push("system_prompt must be 10000 characters or less");
    }
  }
  return errors;
}

/** Validate default_provider references an existing provider key */
export function validateDefaultProvider(defaultProvider: string, providers: Record<string, unknown>): string | null {
  if (!providers[defaultProvider]) {
    return `default_provider "${defaultProvider}" not found in providers`;
  }
  return null;
}

/**
 * Sanitize a loaded config — fix invalid values to defaults.
 * Returns true if any field was corrected (caller should save).
 */
export function sanitizeConfig(config: PpmConfig): boolean {
  let dirty = false;

  // Fix invalid theme
  if (!VALID_THEMES.includes(config.theme)) {
    config.theme = DEFAULT_CONFIG.theme;
    dirty = true;
  }

  // Fix invalid default_provider — must be in VALID_PROVIDERS or be a registered provider key
  if (!VALID_PROVIDERS.includes(config.ai.default_provider as any) &&
      !config.ai.providers[config.ai.default_provider]) {
    config.ai.default_provider = DEFAULT_CONFIG.ai.default_provider;
    dirty = true;
  }

  // Ensure the default provider has a config entry
  if (!config.ai.providers[config.ai.default_provider]) {
    config.ai.providers[config.ai.default_provider] =
      structuredClone(DEFAULT_CONFIG.ai.providers[DEFAULT_CONFIG.ai.default_provider]!);
    dirty = true;
  }

  // Downgrade "max" effort → "high" (not available for Claude.ai subscribers)
  for (const provider of Object.values(config.ai.providers)) {
    if ((provider as any).effort === "max") {
      provider.effort = "high";
      dirty = true;
    }
    // Fix invalid permission_mode
    if (provider.permission_mode != null && !["default", "acceptEdits", "plan", "bypassPermissions"].includes(provider.permission_mode)) {
      provider.permission_mode = "bypassPermissions";
      dirty = true;
    }
  }

  return dirty;
}
