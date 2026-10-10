import { redactFields } from "./codex-redact.ts";
import { commandDisplayText, shellToolName } from "./codex-event-mapper.ts";

/**
 * What a codex approval card shows: the tool's name and the input the user is deciding on.
 *
 * Codex's request carries a lot the user does not decide on (thread, turn and item ids, the
 * decisions it offers, a proposed exec-policy amendment), and its `command` is the interpreter
 * wrapped around the script with every backslash in the interpreter path doubled. Shown raw, a
 * one-word `dir` became a screen of escaped JSON labelled "Bash" on a Windows host running
 * PowerShell. The card gets the script as the tool card shows it, the directory it runs in and
 * codex's reason, each field redacted on its own so the card renders an object, not a string.
 */

type Params = Record<string, unknown>;

function asParams(params: unknown): Params {
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Params) : {};
}

function isCommandApproval(method: string): boolean {
  return method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
}

function isFileChangeApproval(method: string): boolean {
  return method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
}

/**
 * The script to show. The current protocol sends the wrapped command as a string beside its
 * `commandActions`; the legacy one sends argv beside `parsedCmd` (each with `cmd`).
 */
function commandText(p: Params): string {
  const legacyActions = Array.isArray(p.parsedCmd)
    ? p.parsedCmd.map((a) => ({ command: (a as Params | null)?.cmd }))
    : undefined;
  return commandDisplayText({
    command: Array.isArray(p.command) ? p.command.filter((c) => typeof c === "string").join(" ") : p.command,
    commandActions: p.commandActions ?? legacyActions,
  });
}

/** Only the fields a person decides on, dropping the empty ones so the card has no blank rows. */
function compact(fields: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** The card's title: the shell a command runs in, Edit for a patch, else the tool codex names. */
export function approvalToolLabel(method: string, params: unknown): string {
  const p = asParams(params);
  if (isCommandApproval(method)) return shellToolName(p.command);
  if (isFileChangeApproval(method)) return "Edit";
  if (method === "item/tool/requestUserInput") return "AskUserQuestion";
  return String(p.tool ?? "Tool");
}

/** The card's input: structured, every string redacted and capped on its own. */
export function approvalInput(method: string, params: unknown): unknown {
  const p = asParams(params);
  if (isCommandApproval(method)) {
    return redactFields(compact({ command: commandText(p), cwd: p.cwd, reason: p.reason }));
  }
  if (isFileChangeApproval(method)) {
    // The current protocol names no file here (the change's own card above lists them); the
    // legacy one keys its changes by path.
    const files = p.fileChanges && typeof p.fileChanges === "object" ? Object.keys(p.fileChanges as Params) : undefined;
    return redactFields(compact({ files, reason: p.reason, grantRoot: p.grantRoot }));
  }
  return redactFields(p);
}
