import type { ExtensionContributes } from "../../types/extension.ts";

/**
 * The command an extension tab with no panel dispatches to get one: its viewType, which equals
 * the command that opens the panel (a slug whose trailing `.view` was stripped gets it back).
 */
export function panelCommandOf(viewType: string): string {
  return viewType.includes(".") ? viewType : `${viewType}.view`;
}

/**
 * Whether a tab may run its panel's command to get the panel back (a reload, a restored layout,
 * another device). The tab is part of the saved layout, so it can come from a link anyone sent:
 * running whatever command it names would let a link run an action such as marking an item done,
 * on every reload and every device, until the tab is closed. It may run the command when:
 * - the tab records the extension that owns that command, which only a panel the extension really
 *   opened (or a tab it opened itself) records; or
 * - the extension lists the command in `contributes.deepLinkCommands`, i.e. marked it safe to open
 *   from a link.
 */
export function mayRecoverPanel(
  tab: { viewType?: string; extensionId?: string },
  contributions: Pick<ExtensionContributes, "commands" | "deepLinkCommands"> | null | undefined,
): boolean {
  if (!tab.viewType || !contributions) return false;
  const command = panelCommandOf(tab.viewType);
  if (contributions.deepLinkCommands?.includes(command)) return true;
  if (!tab.extensionId) return false;
  const owner = (contributions.commands ?? []).find((c) => c.command === command) as { extId?: string } | undefined;
  return owner?.extId === tab.extensionId;
}
