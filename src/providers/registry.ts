import type { AIProvider } from "./provider.interface.ts";
import { MockProvider } from "./mock-provider.ts";
import { ClaudeAgentSdkProvider } from "./claude-agent-sdk.ts";
import { configService } from "../services/config.service.ts";
import { nextProbeDelayMs, type ProviderProbeStatus } from "./provider-probe.ts";
import { CODEX_DEFAULT_MODEL } from "../types/config.ts";

export interface ProviderInfo {
  id: string;
  name: string;
}

class ProviderRegistry {
  private providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  /** List providers visible to users (excludes internal-only providers like mock) */
  list(): ProviderInfo[] {
    return Array.from(this.providers.values())
      .filter((p) => p.id !== "mock")
      .map((p) => ({ id: p.id, name: p.name }));
  }

  /** List all registered providers including internal ones (for ChatService aggregation) */
  listAll(): ProviderInfo[] {
    return Array.from(this.providers.values())
      .map((p) => ({ id: p.id, name: p.name }));
  }

  /** Get the default provider based on config's default_provider */
  getDefault(): AIProvider {
    const defaultId = configService.get("ai").default_provider;
    const provider = this.providers.get(defaultId);
    if (provider) return provider;
    // Fallback to "claude" if config value doesn't match any registered provider
    const fallback = this.providers.get("claude");
    if (fallback) return fallback;
    throw new Error(`Default provider "${defaultId}" not found in registry`);
  }
}

/** Singleton registry */
export const providerRegistry = new ProviderRegistry();

// SDK providers registered synchronously (no binary check needed)
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new MockProvider()); // testing only

/**
 * Bootstrap CLI providers asynchronously.
 * Checks isAvailable() before registering — call at server startup.
 *
 * Cursor's probe is a local `which`, so it answers the same at every restart.
 * Codex's reaches the network, so its failure is retried rather than final —
 * see probeCodexProvider() below.
 *
 * Persists provider entries with set() only, never save(): set() writes just the
 * "ai" row, while save() rewrites every config key and re-syncs the projects
 * table from this process's in-memory config. A caller that bootstraps without
 * configService.load() first still holds pristine defaults, so a save() here
 * would blank the auth token and delete every project in the real database.
 */
export async function bootstrapProviders(): Promise<void> {
  try {
    const { CursorCliProvider } = await import("./cursor-cli/cursor-provider.ts");
    const cursor = new CursorCliProvider();
    if (await cursor.isAvailable()) {
      providerRegistry.register(cursor);
      // Ensure config has an entry for cursor so settings UI shows it
      const ai = configService.get("ai");
      if (!ai.providers["cursor"]) {
        configService.set("ai", {
          ...ai,
          providers: {
            ...ai.providers,
            cursor: { type: "cli", cli_command: "cursor-agent", permission_mode: "bypassPermissions" },
          },
        });
      }
      console.log("[registry] Cursor provider registered (cursor-agent found)");
    } else {
      console.log("[registry] Cursor provider skipped (cursor-agent not found)");
    }
  } catch (e) {
    console.warn("[registry] Failed to load Cursor provider:", (e as Error).message);
  }

  await probeCodexProvider();
}

// ── Codex availability: probed, remembered, and retried ──────────────────

const probeStatuses = new Map<string, ProviderProbeStatus>();
let codexRetryTimer: ReturnType<typeof setTimeout> | null = null;
let codexProbeInFlight: Promise<ProviderProbeStatus> | null = null;

/** What the last probe of each CLI provider concluded. Empty before bootstrap. */
export function providerProbeStatuses(): ProviderProbeStatus[] {
  return Array.from(probeStatuses.values());
}

/** Probe again now, ahead of whatever the backoff had scheduled (Settings' Retry). */
export function retryProviderProbe(id: string): Promise<ProviderProbeStatus> {
  if (id !== "codex") throw new Error(`Provider "${id}" has no retryable probe`);
  return probeCodexProvider();
}

/**
 * Give codex a config entry, but only when it has never had one. An absent
 * `model` is a real choice — the settings picker writes it for "Auto (default)",
 * which hands model selection back to codex — so filling one in on every probe
 * would undo that choice. Existing installs are given the default once, by
 * migration.
 */
function ensureCodexConfigEntry(): void {
  const ai = configService.get("ai");
  if (ai.providers["codex"]) return;
  configService.set("ai", {
    ...ai,
    providers: {
      ...ai.providers,
      codex: {
        type: "cli",
        cli_command: "codex",
        permission_mode: "bypassPermissions",
        model: CODEX_DEFAULT_MODEL,
      },
    },
  });
}

/** Arm the next probe. The timer is unref'd so it never holds the process open. */
function scheduleCodexRetry(failedAttempts: number): string {
  const delay = nextProbeDelayMs(failedAttempts);
  codexRetryTimer = setTimeout(() => {
    codexRetryTimer = null;
    void probeCodexProvider();
  }, delay);
  codexRetryTimer.unref?.();
  return new Date(Date.now() + delay).toISOString();
}

/**
 * Probe codex and register it if it answers. On a retryable failure — which is
 * nearly every failure, see `provider-probe.ts` — arm the next attempt instead
 * of leaving the provider missing until someone restarts PPM.
 */
async function probeCodexProvider(): Promise<ProviderProbeStatus> {
  // Probing again once it serves would put a fresh instance in the registry and
  // orphan the live app-server clients the old one holds — every open codex
  // session, and the cleanup handle the server shuts down through.
  const current = probeStatuses.get("codex");
  if (current?.registered) return current;
  if (codexProbeInFlight) return codexProbeInFlight;
  if (codexRetryTimer) {
    clearTimeout(codexRetryTimer);
    codexRetryTimer = null;
  }
  codexProbeInFlight = (async (): Promise<ProviderProbeStatus> => {
    const attempts = (probeStatuses.get("codex")?.attempts ?? 0) + 1;
    const lastProbeAt = new Date().toISOString();
    let status: ProviderProbeStatus;
    try {
      const { CodexAppServerProvider } = await import("./codex-app-server/codex-provider.ts");
      const codex = new CodexAppServerProvider();
      const result = await codex.probe();
      if (result.ok) {
        providerRegistry.register(codex);
        ensureCodexConfigEntry();
        console.log("[registry] Codex provider registered (@openai/codex found)");
        status = { id: "codex", registered: true, attempts, lastProbeAt };
      } else {
        status = { id: "codex", registered: false, attempts, lastProbeAt, reason: result.reason };
        if (result.retryable) status.nextProbeAt = scheduleCodexRetry(attempts);
        console.log(
          `[registry] Codex provider unavailable: ${result.reason}` +
          (status.nextProbeAt ? ` — retrying at ${status.nextProbeAt}` : ""),
        );
      }
    } catch (e) {
      // A broken import is a bug, not a flat host — but it is still worth
      // retrying, since the alternative is silence until the next restart.
      status = { id: "codex", registered: false, attempts, lastProbeAt, reason: (e as Error).message };
      status.nextProbeAt = scheduleCodexRetry(attempts);
      console.warn("[registry] Failed to load Codex provider:", (e as Error).message);
    }
    probeStatuses.set("codex", status);
    return status;
  })();
  try {
    return await codexProbeInFlight;
  } finally {
    codexProbeInFlight = null;
  }
}
