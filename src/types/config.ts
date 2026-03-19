export interface PushConfig {
  vapid_public_key: string;
  vapid_private_key: string;
  vapid_subject: string;
}

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
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

export interface AIProviderConfig {
  type: "agent-sdk" | "mock";
  api_key_env?: string;
  // Agent SDK-specific settings (ignored by mock provider)
  model?: string;
  effort?: "low" | "medium" | "high";
  max_turns?: number;
  max_budget_usd?: number;
  thinking_budget_tokens?: number;
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
      },
    },
  },
};

const VALID_TYPES = ["agent-sdk", "mock"] as const;
const VALID_EFFORTS = ["low", "medium", "high"] as const;
const VALID_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"] as const;
/** Only these values are allowed for default_provider in config */
export const VALID_PROVIDERS = ["claude"] as const;
const VALID_THEMES: ThemeConfig[] = ["light", "dark", "system"];

/** Validate AI provider config fields. Returns array of error messages (empty = valid). */
export function validateAIProviderConfig(config: Partial<AIProviderConfig>): string[] {
  const errors: string[] = [];
  if (config.type != null && !VALID_TYPES.includes(config.type as any)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(", ")}`);
  }
  if (config.model != null && !VALID_MODELS.includes(config.model as any)) {
    errors.push(`model must be one of: ${VALID_MODELS.join(", ")}`);
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

  // Fix invalid default_provider — must be in VALID_PROVIDERS
  if (!VALID_PROVIDERS.includes(config.ai.default_provider as any)) {
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
  }

  return dirty;
}
