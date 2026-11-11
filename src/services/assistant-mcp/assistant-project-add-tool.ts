import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import { PROJECT_ADD_TOOL } from "../../shared/assistant-tool-names.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { projectService } from "../project.service.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";
import type { AskApproval } from "./assistant-approval-broker.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";

/**
 * `project_add` — register a folder on this machine as a PPM project, after the user approves a
 * card naming the folder exactly. Registering one is what lets every other tool, a manager chat
 * and the user's own chats work there, and the Assistant then reads inside it without asking, so
 * a folder that would put the user's whole home, a drive, or PPM's own credentials inside a
 * project is refused before anyone is asked: the user can still add it themselves in PPM.
 */

export interface ProjectAddDeps {
  list?: () => { name: string; path: string }[];
  add?: (path: string, name?: string) => { name: string; path: string };
  /** Tells every open PPM the project list changed. */
  announce?: () => void;
  home?: string;
  ppmDir?: string;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Why the Assistant must not register this folder, or null when it may ask to. */
export function projectFolderRefusal(abs: string, home: string, ppmDir: string): string | null {
  if (dirname(abs) === abs) return `${abs} is a whole drive.`;
  if (inside(home, abs)) return `${abs} holds your whole home folder.`;
  if (inside(ppmDir, abs) || inside(abs, ppmDir) || isCredentialPath(abs)) return `${abs} holds PPM's own data and credentials.`;
  return null;
}

export function projectAddSummary(input: { name: string; path: string; git: boolean }): ApprovalSummary {
  return {
    headline: `Add ${input.name} as a PPM project`,
    facts: [
      exactFact("Folder", input.path),
      exactFact("Name", input.name),
      fact("Git repository", input.git ? "Yes" : "No"),
    ],
    warning: "Chats, terminals and the Assistant can then work in this folder, and the Assistant reads files inside it without asking first.",
  };
}

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

export async function projectAddTool(args: Record<string, unknown>, ask: AskApproval, deps: ProjectAddDeps = {}): Promise<Json> {
  if (typeof args.path !== "string" || !args.path.trim()) return errorResult("`path` is required: the folder's full path.");
  const raw = args.path.trim();
  if (!isAbsolute(raw)) return errorResult(`\`path\` must be a full path, such as D:\\Projects\\app or /home/me/app; got "${raw.slice(0, 200)}".`);
  if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) {
    return errorResult("`name`, when given, must be a non-empty name; leave it out to use the folder's name.");
  }
  const abs = resolve(raw);
  const name = typeof args.name === "string" ? args.name.trim() : basename(abs);
  if (!existsSync(abs)) return errorResult(`There is no folder at ${abs}. Nothing was added.`);
  if (!isDir(abs)) return errorResult(`${abs} is a file, not a folder. Nothing was added.`);

  const refusal = projectFolderRefusal(abs, deps.home ?? homedir(), deps.ppmDir ?? getPpmDir());
  if (refusal) {
    return errorResult(`Not added: ${refusal} The Assistant does not register such a folder; the user can add it themselves from PPM's project switcher (Add project).`);
  }
  const list = deps.list ?? (() => projectService.list());
  const clash = (): string | null => {
    const projects = list();
    const samePath = projects.find((p) => resolve(p.path) === abs);
    if (samePath) return `${abs} is already the project "${samePath.name}".`;
    if (projects.some((p) => p.name === name)) return `A project is already named "${name}"; pass another \`name\`.`;
    return null;
  };
  const before = clash();
  if (before) return errorResult(`Not added: ${before}`);

  const verdict = await ask({
    tool: PROJECT_ADD_TOOL,
    input: { path: abs, name },
    summary: projectAddSummary({ name, path: abs, git: existsSync(resolve(abs, ".git")) }),
  });
  if (verdict.verdict !== "approved") return errorResult(`Not added: the user's approval was not given — ${verdict.reason}`);

  // The answer can come much later: someone may have added it, or the folder may be gone.
  const after = clash();
  if (after) return errorResult(`Not added: ${after}`);
  if (!isDir(abs)) return errorResult(`Not added: ${abs} is no longer a folder.`);
  try {
    const added = (deps.add ?? ((p, n) => projectService.add(p, n)))(abs, name);
    deps.announce?.();
    return jsonResult({ added: true, name: added.name, path: added.path });
  } catch (e) {
    return errorResult(`Not added: ${(e as Error).message}`);
  }
}
