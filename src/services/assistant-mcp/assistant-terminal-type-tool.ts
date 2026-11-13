import { isAbsolute, resolve } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import { TERMINAL_TYPE_TOOL } from "../../shared/assistant-tool-names.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { RUN_IN_TERMINAL_TOOL } from "../../shared/tab-open-protocol.ts";
import { ppmToolOn } from "../../shared/ppm-tools.ts";
import { configService } from "../config.service.ts";
import { projectService } from "../project.service.ts";
import { isUnattendedTurn, UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import { isInsideDir } from "../fs-ops/fs-real-path.ts";
import { resolvePath } from "../fs-path-guard.service.ts";
import type { TabToolsBinding } from "../tab-tools-mcp/tab-target.ts";
import type { TerminalRunOptions } from "../tab-tools-mcp/terminal-tools.ts";
import { resolveAssistantProject, type AssistantProject } from "./assistant-project-scope.ts";
import { TERMINAL_TYPE_MAX_CHARS } from "./assistant-terminal-type-tool-definition.ts";
import { errorResult } from "./assistant-tool-output.ts";

/**
 * `terminal_type`: the PPM Assistant types one shell command into a new terminal for the user to
 * run, through the same machinery as an ordinary chat's `run_in_terminal`. Nothing runs before the
 * user presses Enter, the line is one visible line of at most {@link TERMINAL_TYPE_MAX_CHARS}
 * characters, and the terminal keeps the AI-chat mark for its whole life.
 *
 * The Assistant floats over whatever project the device shows, and its own project is no
 * workspace, so the terminal opens in the dock of the project the device shows while its shell
 * starts in the folder of the project the call names; the answer names both.
 *
 * It follows the user's `run_in_terminal` switch in Settings → Tools, and is refused in any turn
 * the user did not start from PPM itself with only their own words in it: a turn that read text
 * the user did not write, one PPM started on its own, and one that came from Telegram — that turn's
 * terminal would open on every device showing the chat, with nobody known to be at any of them.
 */

const INSTEAD = "Give the user the command to run instead.";

export interface TerminalTypeContext {
  sessionId: string;
  /** The turn's provenance before this call: unknown counts as not the user's own. */
  provenanceAtCall?: AssistantProvenance;
}

export interface TerminalTypeDeps {
  /** Whether the user has `run_in_terminal` on (Settings → Tools). */
  enabled(): boolean;
  unattended(sessionId: string): boolean;
  projects(): AssistantProject[];
  /** The shared terminal tools' `run`. */
  run(binding: TabToolsBinding, args: Record<string, unknown>, opts: TerminalRunOptions): Promise<Json>;
}

/** Why this turn may not type into a terminal; null when it may. */
function turnRefusal(p: AssistantProvenance | undefined): string | null {
  if (!p) return `Refused: PPM cannot tell who started this turn, so nothing is typed into a terminal. ${INSTEAD}`;
  if (p.untrusted) {
    return `Refused: text the user did not write reached this turn${p.reason ? ` (${p.reason})` : ""}, and a line typed into `
      + `their terminal is one Enter away from running. ${INSTEAD}`;
  }
  if (p.startedBy === "user_telegram") {
    return "Refused: this turn came from Telegram, so PPM cannot tell which device the user is looking at, and the "
      + `terminal would open on every device showing this chat. ${INSTEAD}`;
  }
  return p.startedBy === "user_ppm" ? null : UNATTENDED_TURN_REFUSAL;
}

/** The folder the shell starts in: the project's own, or one inside it. */
function startFolder(cwd: unknown, project: AssistantProject): { ok: true; dir: string } | { ok: false; error: string } {
  if (cwd === undefined || cwd === null || cwd === "") return { ok: true, dir: project.path };
  if (typeof cwd !== "string" || cwd.length > 4096 || cwd.includes("\0")) return { ok: false, error: "`cwd` is not a valid folder path." };
  const raw = cwd.trim();
  const dir = isAbsolute(raw) || raw.startsWith("~") ? resolvePath(raw) : resolve(project.path, raw);
  if (!isInsideDir(resolve(dir), resolve(project.path))) {
    return { ok: false, error: `\`cwd\` must be a folder inside project "${project.name}" (${project.path}); ${dir} is not.` };
  }
  return { ok: true, dir };
}

export async function terminalTypeTool(ctx: TerminalTypeContext, args: Record<string, unknown>, deps: TerminalTypeDeps = defaultDeps): Promise<Json> {
  if (!deps.enabled()) {
    return errorResult(`${TERMINAL_TYPE_TOOL} follows the ${RUN_IN_TERMINAL_TOOL} switch, which the user turned off in PPM's `
      + `settings (Settings → Tools), so nothing was typed. ${INSTEAD}`);
  }
  if (deps.unattended(ctx.sessionId)) return errorResult(UNATTENDED_TURN_REFUSAL);
  const refused = turnRefusal(ctx.provenanceAtCall);
  if (refused) return errorResult(refused);
  const found = resolveAssistantProject(args.project, () => deps.projects());
  if (!found.ok) return errorResult(found.error);
  const project = found.value;
  const start = startFolder(args.cwd, project);
  if (!start.ok) return errorResult(start.error);
  return deps.run(
    { sessionId: ctx.sessionId, projectPath: project.path, projectName: project.name },
    { command: args.command, cwd: start.dir },
    {
      maxChars: TERMINAL_TYPE_MAX_CHARS,
      dock: "current",
      // The Assistant has no read_terminal; it reads a tab's terminal through the UI tools.
      readHint: (terminal) => `ui_get_state, then ui_read_tab on that terminal's tab (terminal ${terminal})`,
    },
  );
}

const defaultDeps: TerminalTypeDeps = {
  enabled: () => ppmToolOn(configService.get("ai"), RUN_IN_TERMINAL_TOOL),
  unattended: (sessionId) => isUnattendedTurn(sessionId),
  projects: () => projectService.list(),
  // Loaded on first use: the tab tools' module reaches the tunnel routes, which the Assistant's
  // endpoint has no other reason to load.
  run: async (binding, args, opts) => (await import("../tab-tools-mcp/tab-tools-mcp-endpoint.ts")).terminalTools.run(binding, args, opts),
};
