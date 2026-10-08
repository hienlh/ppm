import { getConnections, type ConnectionRow } from "../db.service.ts";
import { DB_TYPE_LABELS } from "../../shared/db-types.ts";

/**
 * The saved connections an AI chat's database tools reach: every one with "Available to the AI
 * chat" on (`ai_access`), the same set `ppm db` shows inside a chat. A connection is named by its
 * name, as the user sees it in the CONNECTIONS tree.
 */

/** Connections listed in the tools' descriptions; more are still reachable by name. */
const MAX_LISTED = 50;

export function aiConnections(): ConnectionRow[] {
  return getConnections().filter((c) => c.ai_access !== 0);
}

/** One line per connection the AI may use, for the tools' descriptions. */
export function describeAiConnections(conns: ConnectionRow[] = aiConnections()): string {
  if (conns.length === 0) {
    return "No connection is available to the AI chat: the user has none saved in PPM, or turned \"Available to the AI chat\" off on each.";
  }
  const lines = conns.slice(0, MAX_LISTED).map((c) => {
    const notes = [DB_TYPE_LABELS[c.type] ?? c.type, ...(c.group_name ? [`folder ${c.group_name}`] : []), ...(c.readonly ? ["readonly"] : [])];
    return `- ${c.name} (${notes.join(", ")})`;
  });
  if (conns.length > MAX_LISTED) lines.push(`- …and ${conns.length - MAX_LISTED} more`);
  return `Connections saved in PPM that you may use:\n${lines.join("\n")}`;
}

export type AiConnectionOutcome = { ok: true; conn: ConnectionRow } | { ok: false; error: string };

/** The connection `name` names, when the AI may use it; otherwise what to tell the AI. */
export function findAiConnection(name: unknown): AiConnectionOutcome {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: `\`connection\` is required: the name of a connection saved in PPM.\n${describeAiConnections()}` };
  }
  const wanted = name.trim();
  const all = getConnections();
  const conn = all.find((c) => c.name === wanted) ?? all.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!conn) return { ok: false, error: `No connection named "${wanted}" is saved in PPM.\n${describeAiConnections()}` };
  if (conn.ai_access === 0) {
    return {
      ok: false,
      error: `Connection "${conn.name}" is not available to the AI chat: "Available to the AI chat" is off in its settings in PPM. Ask the user to turn it on, or to run the SQL themselves.`,
    };
  }
  return { ok: true, conn };
}
