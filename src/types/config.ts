export interface PpmConfig {
  port: number;
  host: string;
  auth: AuthConfig;
  projects: ProjectConfig[];
  ai: AIConfig;
}

export interface AuthConfig {
  enabled: boolean;
  token: string;
}

export interface ProjectConfig {
  path: string;
  name: string;
}

export interface AIConfig {
  default_provider: string;
  providers: Record<string, AIProviderConfig>;
}

export interface AIProviderConfig {
  type: "agent-sdk" | "cli";
  api_key_env?: string;
  command?: string;
}

export const DEFAULT_CONFIG: PpmConfig = {
  port: 8080,
  host: "0.0.0.0",
  auth: { enabled: true, token: "" },
  projects: [],
  ai: {
    default_provider: "claude",
    providers: {
      claude: { type: "agent-sdk", api_key_env: "ANTHROPIC_API_KEY" },
    },
  },
};
