import type { SlashItem } from "./types.ts";

/** Split a leading `/name` off a message, if there is one. */
function splitCommand(content: string): { name: string; rest: string } | null {
  const match = content.match(/^\/(\S+)/);
  if (!match) return null;
  return { name: match[1]!, rest: content.slice(match[0].length) };
}

/**
 * Rewrite a leading slash command that used a legacy alias into the name the
 * runtime actually registers.
 *
 * Claude Code names a plugin item after its location, prefixed by the owning
 * plugin (`/ak-engineer:ak-debug`). Kits that instead declare a self-namespaced
 * frontmatter name (AgentKit ships `name: ak:debug`) publish a name nothing can
 * resolve, so users typing the documented `/ak:debug` get a dead command. The
 * declared name is kept as an alias during discovery; this turns it back into
 * the canonical one.
 *
 * When two plugins claim the same alias — the AgentKit engineer and marketing
 * kits overlap on ~30 skills — the first match in discovery order wins, which
 * follows the plugin registry order.
 *
 * Unknown commands pass through untouched: reporting those is the SDK's job.
 */
export function rewriteSlashAlias(content: string, items: SlashItem[]): string {
  const cmd = splitCommand(content);
  if (!cmd) return content;
  // A name that already resolves is never rewritten, even if some other item
  // happens to alias it.
  if (items.some((item) => item.name === cmd.name)) return content;
  const hit = items.find((item) => item.aliases?.includes(cmd.name));
  return hit ? `/${hit.name}${cmd.rest}` : content;
}
