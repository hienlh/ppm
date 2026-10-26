import { deepLinkArgsProblem, isDeepLinkId, type DeepLinkArg, type ExtensionDeepLinkTarget } from "../../shared/extension-deep-link.ts";
import { getExtensionById } from "../db.service.ts";
import type { ExtensionManifest } from "../../types/extension.ts";

/** The command ids an installed extension declared in its own manifest. */
export function declaredCommands(id: string): string[] {
  const row = getExtensionById(id);
  if (!row) return [];
  try {
    const manifest = JSON.parse(row.manifest) as ExtensionManifest;
    return (manifest.contributes?.commands ?? []).map((c) => c.command).filter((c) => typeof c === "string");
  } catch {
    return [];
  }
}

/**
 * The `open` field of a `ppm.notify` request: which of the calling extension's own commands or
 * panels the notification opens. Only what that extension declared in `contributes.commands`
 * may be named (a panel's viewType equals the command that opens it), so a link can never be
 * used to reach another extension's command. Returns the checked target or a reason.
 */
export function checkNotifyOpen(
  raw: unknown,
  declaredCommands: readonly string[],
): { ok: true; open: ExtensionDeepLinkTarget } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "open must be { command, args? } or { view }" };
  }
  const o = raw as Record<string, unknown>;
  const hasCommand = o.command !== undefined;
  const hasView = o.view !== undefined;
  if (hasCommand === hasView) return { ok: false, message: "open must name exactly one of command or view" };

  const id = hasCommand ? o.command : o.view;
  const field = hasCommand ? "open.command" : "open.view";
  if (!isDeepLinkId(id)) return { ok: false, message: `${field} must be 1 to 200 letters, digits, ".", "-" or "_"` };
  if (!declaredCommands.includes(id)) {
    return { ok: false, message: `${field} "${id}" is not declared in this extension's contributes.commands` };
  }
  if (hasView) {
    if (o.args !== undefined) return { ok: false, message: "open.args only goes with open.command" };
    return { ok: true, open: { view: id } };
  }
  const args = o.args ?? [];
  const problem = deepLinkArgsProblem(args);
  if (problem) return { ok: false, message: `open.${problem}` };
  return { ok: true, open: { command: id, args: args as DeepLinkArg[] } };
}
