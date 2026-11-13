import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { aiKey, aiSettingRefusal, planAiSettingWrite } from "../utils/ai-setting-write.ts";
import { flattenConfig } from "../utils/config-key-path.ts";
import { redactSecretConfigValue } from "../../services/config-secret-keys.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";

/**
 * `ppm ai` — Settings → AI Provider and the AI parts of Settings → Tools, through the same routes,
 * so the server validates every change and every open PPM's pane refreshes. A provider's API key
 * is never printed or set here (Settings → AI Provider).
 */

type ProbeStatus = { id: string; registered: boolean; reason?: string; nextProbeAt?: string };

/** The AI settings as the route answers them, with every secret replaced by a marker. */
async function aiSettings(): Promise<Record<string, unknown>> {
  const ai = await settingsRequest<Record<string, unknown>>("GET", "/ai");
  return redactSecretConfigValue("ai", ai) as Record<string, unknown>;
}

const printStatus = (s: ProbeStatus) =>
  console.log(`${s.id.padEnd(8)} ${s.registered ? `${C.green}available${C.reset}` : `${C.yellow}unavailable${C.reset}`}`
    + `${s.reason ? `  ${C.dim}${s.reason}${C.reset}` : ""}${s.nextProbeAt ? `  ${C.dim}(next try ${s.nextProbeAt})${C.reset}` : ""}`);

export function registerAiCommands(program: Command): void {
  const ai = program.command("ai").description("Show or change the AI provider settings");

  ai
    .command("get [key]")
    .description("Show the AI settings, or one of them (e.g. default_provider, providers.claude.model); secrets are never shown")
    .option("--json", "Print JSON")
    .action((key: string | undefined, opts: { json?: boolean }) => run(async () => {
      const settings = await aiSettings();
      if (key) {
        const flat = flattenConfig(settings);
        const k = aiKey(key);
        const value = flat[k] ?? Object.fromEntries(Object.entries(flat).filter(([p]) => p.startsWith(`${k}.`)));
        if (typeof value === "object" && Object.keys(value).length === 0) fail(`No AI setting "${k}"`);
        console.log(opts.json || typeof value === "object" ? JSON.stringify(value, null, 2) : `${k} = ${String(value)}`);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(settings, null, 2));
        return;
      }
      for (const [k, v] of Object.entries(flattenConfig(settings)).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`${C.cyan}${k}${C.reset} = ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
      }
    })());

  ai
    .command("set <key> <value>")
    .description("Change one AI setting (e.g. default_provider codex, providers.claude.effort high, ppm_tools.open_url false)")
    .action((key: string, value: string) => run(async () => {
      // Refused before anything is asked of PPM: a secret on a command line is already a leak.
      const refusal = aiSettingRefusal(key, { aiChat: inAiChat() });
      if (refusal) return fail(refusal);
      const current = await aiSettings();
      const plan = planAiSettingWrite(key, value, current, { aiChat: inAiChat() });
      if (!plan.ok) return fail(plan.error);
      await settingsRequest("PUT", "/ai", plan.body);
      console.log(`${C.green}Updated:${C.reset} ai.${aiKey(key)} = ${String(plan.value)}`);
    })());

  ai
    .command("providers")
    .description("Which providers chat can use now, and why one cannot")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const statuses = await settingsRequest<ProbeStatus[]>("GET", "/ai/providers/status");
      if (opts.json) console.log(JSON.stringify(statuses, null, 2));
      else if (statuses.length === 0) console.log(`${C.dim}No provider is probed; Claude is always available.${C.reset}`);
      else statuses.forEach(printStatus);
    })());

  ai
    .command("probe <provider>")
    .description("Check a provider again now, ahead of its next scheduled try")
    .action((id: string) => run(async () => {
      printStatus(await settingsRequest<ProbeStatus>("POST", `/ai/providers/${encodeURIComponent(id)}/probe`, {}, { timeoutMs: 60_000 }));
    })());

  ai
    .command("models <provider>")
    .description("List the models a provider offers")
    .option("--json", "Print JSON")
    .action((id: string, opts: { json?: boolean }) => run(async () => {
      const models = await settingsRequest<Array<{ value: string; label: string }>>("GET", `/ai/providers/${encodeURIComponent(id)}/models`, undefined, { timeoutMs: 60_000 });
      if (opts.json) console.log(JSON.stringify(models, null, 2));
      else for (const m of models) console.log(`${m.value}  ${C.dim}${m.label}${C.reset}`);
    })());
}
