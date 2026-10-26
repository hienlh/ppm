import {
  deepLinkArgsProblem, deepLinkableCommands, isDeepLinkId, type DeepLinkArg, type ExtensionDeepLinkTarget,
} from "../../shared/extension-deep-link.ts";
import { getExtensionById } from "../db.service.ts";
import type { ExtensionManifest } from "../../types/extension.ts";

/** What an installed extension's manifest lets a notification link to. */
export interface LinkableTargets {
  /** Every command it declares: a panel's viewType equals the command that opens it. */
  commands: string[];
  /** The commands it marked as safe to run from a link (`contributes.deepLinkCommands`). */
  deepLinkCommands: string[];
}

export function linkableTargets(id: string): LinkableTargets {
  const row = getExtensionById(id);
  if (!row) return { commands: [], deepLinkCommands: [] };
  try {
    const contributes = (JSON.parse(row.manifest) as ExtensionManifest).contributes;
    return {
      commands: (contributes?.commands ?? []).map((c) => c.command).filter((c) => typeof c === "string"),
      deepLinkCommands: deepLinkableCommands(contributes),
    };
  } catch {
    return { commands: [], deepLinkCommands: [] };
  }
}

/**
 * The `open` field of a `ppm.notify` request: which of the calling extension's own panels or
 * linkable commands the notification opens. A view must be one of its declared commands (a
 * panel's viewType equals the command that opens it). A command must also be in its
 * `contributes.deepLinkCommands`: anyone holding the link can open it, so a link may never run an
 * action such as marking an item done. Returns the checked target or a reason.
 */
export function checkNotifyOpen(
  raw: unknown,
  targets: LinkableTargets,
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
  if (!targets.commands.includes(id)) {
    return { ok: false, message: `${field} "${id}" is not declared in this extension's contributes.commands` };
  }
  if (hasView) {
    if (o.args !== undefined) return { ok: false, message: "open.args only goes with open.command" };
    return { ok: true, open: { view: id } };
  }
  if (!targets.deepLinkCommands.includes(id)) {
    return { ok: false, message: `open.command "${id}" is not in this extension's contributes.deepLinkCommands` };
  }
  const args = o.args ?? [];
  const problem = deepLinkArgsProblem(args);
  if (problem) return { ok: false, message: `open.${problem}` };
  return { ok: true, open: { command: id, args: args as DeepLinkArg[] } };
}
