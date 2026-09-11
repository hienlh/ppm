import { registerUsageSource } from "./usage-registry.ts";
import { claudeUsageSource } from "../claude-usage-source.ts";
import { codexUsageSource } from "../../providers/codex-app-server/codex-usage-source.ts";

/**
 * Wires the concrete providers into the shared usage layer.
 *
 * Separate from `index.ts` so the layer itself imports no provider, and a
 * provider importing the layer cannot create a cycle back through registration.
 * Adding a provider is one line here plus its own source file.
 *
 * Idempotent: registration is keyed by provider id, so calling it again (a
 * `bun --hot` reload, a test re-import) replaces rather than duplicates.
 */
export function registerAllUsageSources(): void {
  registerUsageSource(claudeUsageSource);
  registerUsageSource(codexUsageSource);
}
