import { CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";
import { parseSkillList } from "./codex-skill-parser.ts";

interface SkillLister {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/**
 * The skills to switch off by name for a PPM Assistant session on this app-server.
 *
 * A home of its own (`codex-assistant-home.ts`) leaves `$CODEX_HOME/skills` behind, but codex
 * also discovers skills under the user's home folder (`~/.agents/skills`), whatever CODEX_HOME
 * says. `skills.include_instructions = false` (set by `assistantSessionConfig`) keeps their
 * catalogue out of the prompt, and that is not enough on its own: measured on codex 0.162, a
 * `$skill-name` in the message still injects that skill's whole SKILL.md. A `skills.config`
 * entry with `enabled = false` for the name stops that too, so every skill this app-server
 * reports for the session's folder is returned here.
 *
 * Fail-open, unlike the MCP plan: with the catalogue already out of the prompt, a skill can only
 * be reached by the user typing its name, so a failed listing costs no protection worth refusing
 * the session over. The caller logs the failure.
 */
export async function planAssistantCodexSkills(client: SkillLister, cwd: string): Promise<string[]> {
  const result = await client.request("skills/list", { cwds: [cwd] }, CONTROL_REQUEST_TIMEOUT_MS);
  return parseSkillList(result).map((skill) => skill.name);
}
