import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readdir } from "fs/promises";

const TEAMS_DIR = join(homedir(), ".claude", "teams");
const DEBOUNCE_MS = 200;

/** Infer message type from JSON text field */
function inferMessageType(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed?.type ?? "message";
  } catch {
    return "message";
  }
}

interface WatcherCallbacks {
  onInboxUpdate: (teamName: string, agent: string, messages: unknown[]) => void;
  onConfigUpdate: (teamName: string, config: unknown) => void;
}

/** Start watching a team's inboxes directory + config.json for changes.
 *  Snapshots are seeded from what is already on disk: a watcher can attach to a
 *  team that has been running for hours, and an unseeded snapshot would replay
 *  every historical message as "new" on the first file change. */
export async function startTeamInboxWatcher(
  teamName: string,
  callbacks: WatcherCallbacks,
): Promise<{ watchers: FSWatcher[]; cleanup: () => void }> {
  const inboxDir = join(TEAMS_DIR, teamName, "inboxes");
  const configPath = join(TEAMS_DIR, teamName, "config.json");
  const watchers: FSWatcher[] = [];
  const inboxSnapshots = new Map<string, number>(); // filename → last known msg count
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Seed from current on-disk state before the first change event lands.
  for (const file of await readInboxFiles(teamName)) {
    try {
      const parsed = JSON.parse(await Bun.file(join(inboxDir, file)).text());
      if (Array.isArray(parsed)) inboxSnapshots.set(file, parsed.length);
    } catch { /* mid-write or malformed — treat as empty */ }
  }

  // Watch inboxes directory
  try {
    const inboxWatcher = watch(inboxDir, (_event, filename) => {
      if (!filename?.endsWith(".json")) return;

      // Debounce per file
      const existing = debounceTimers.get(filename);
      if (existing) clearTimeout(existing);
      debounceTimers.set(filename, setTimeout(async () => {
        debounceTimers.delete(filename);
        try {
          const content = await Bun.file(join(inboxDir, filename)).text();
          const messages = JSON.parse(content);
          const agentName = filename.replace(".json", "");
          const lastKnown = inboxSnapshots.get(filename) ?? 0;

          if (Array.isArray(messages) && messages.length > lastKnown) {
            const newMessages = messages.slice(lastKnown).map((m: any) => ({
              ...m,
              to: agentName,
              parsedType: inferMessageType(m.text ?? ""),
            }));
            inboxSnapshots.set(filename, messages.length);
            callbacks.onInboxUpdate(teamName, agentName, newMessages);
          }
        } catch { /* file mid-write or deleted */ }
      }, DEBOUNCE_MS));
    });
    watchers.push(inboxWatcher);
  } catch { /* inboxes dir may not exist yet */ }

  // Watch config.json
  try {
    const configWatcher = watch(configPath, async () => {
      try {
        const content = await Bun.file(configPath).text();
        callbacks.onConfigUpdate(teamName, JSON.parse(content));
      } catch { /* mid-write */ }
    });
    watchers.push(configWatcher);
  } catch { /* config may not exist */ }

  return {
    watchers,
    cleanup: () => {
      for (const w of watchers) w.close();
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
    },
  };
}

/** Read team config from filesystem */
export async function readTeamConfig(teamName: string): Promise<unknown | null> {
  try {
    const content = await Bun.file(join(TEAMS_DIR, teamName, "config.json")).text();
    return JSON.parse(content);
  } catch { return null; }
}

/** Inbox filenames (`<agent>.json`) for a team, empty when the dir is absent. */
async function readInboxFiles(teamName: string): Promise<string[]> {
  try {
    return (await readdir(join(TEAMS_DIR, teamName, "inboxes"))).filter(f => f.endsWith(".json"));
  } catch { return []; }
}

/** Member record for an agent only known by its inbox filename. */
function synthesizeMember(name: string, teamName: string, status: string) {
  return { name, agentId: `${name}@${teamName}`, agentType: "teammate", model: "unknown", status };
}

/** Whether a team directory holds anything usable.
 *  config.json is optional: Claude Code now creates the team implicitly, named
 *  after the session, and writes only inboxes/. Requiring a config would make
 *  every implicitly-created team invisible. */
export async function teamExists(teamName: string): Promise<boolean> {
  if (await readTeamConfig(teamName)) return true;
  return (await readInboxFiles(teamName)).length > 0;
}

/** List all teams from ~/.claude/teams/ */
export async function listTeams(): Promise<unknown[]> {
  try {
    const entries = await readdir(TEAMS_DIR, { withFileTypes: true });
    const teams = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const config = await readTeamConfig(entry.name) as any;
      if (config) {
        teams.push({ ...config, name: config.name ?? entry.name, implicit: false });
        continue;
      }
      // Implicit team: membership is only discoverable from inbox filenames.
      const inboxFiles = await readInboxFiles(entry.name);
      if (inboxFiles.length === 0) continue;
      teams.push({
        name: entry.name,
        team_name: entry.name,
        implicit: true,
        members: inboxFiles.map(f => synthesizeMember(f.replace(".json", ""), entry.name, "active")),
      });
    }
    return teams;
  } catch { return []; }
}

/** Read team detail with merged inbox messages + inferred member status */
export async function readTeamDetail(teamName: string): Promise<unknown | null> {
  const config = await readTeamConfig(teamName) as any;
  const inboxDir = join(TEAMS_DIR, teamName, "inboxes");
  const inboxFiles = await readInboxFiles(teamName);
  // Only a directory with neither a config nor any inbox is "not a team".
  if (!config && inboxFiles.length === 0) return null;
  const base = config ?? { name: teamName, team_name: teamName, implicit: true };

  const messages: unknown[] = [];
  for (const file of inboxFiles) {
    try {
      const content = await Bun.file(join(inboxDir, file)).text();
      const agentName = file.replace(".json", "");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        messages.push(...parsed.map((m: any) => ({
          ...m,
          to: agentName,
          parsedType: inferMessageType(m.text ?? ""),
        })));
      }
    } catch { /* mid-write or malformed inbox — skip this agent */ }
  }

  // Sort by timestamp
  messages.sort((a: any, b: any) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Infer member status from inboxes
  const members = (base.members ?? []).map((m: any) => ({
    ...m,
    status: inferMemberStatus(messages, m.name),
  }));

  // Discover additional members from inbox filenames (reuse already-read list)
  for (const file of inboxFiles) {
    const name = file.replace(".json", "");
    if (!members.some((m: any) => m.name === name)) {
      members.push(synthesizeMember(name, teamName, inferMemberStatus(messages, name)));
    }
  }

  return { ...base, name: base.name ?? teamName, members, messages, memberCount: members.length };
}

function inferMemberStatus(messages: unknown[], agentName: string): string {
  const fromAgent = (messages as any[]).filter(m => m.from === agentName).reverse();
  if (fromAgent.length === 0) return "active";
  const last = fromAgent[0];
  const type = last.parsedType ?? inferMessageType(last.text ?? "");
  if (type === "shutdown_approved") return "shutdown";
  if (type === "idle_notification") return "idle";
  return "active";
}

/** Extract team name from TeamCreate tool_result output.
 *  Output may be plain JSON, or a content-block array like:
 *  [{"type":"text","text":"{ \"team_name\": \"foo\" }"}] */
export function extractTeamName(output: string): string | null {
  try {
    const parsed = JSON.parse(output);
    // Direct JSON object: { team_name: "foo" }
    if (parsed && !Array.isArray(parsed)) {
      return parsed.team_name ?? parsed.name ?? null;
    }
    // Content-block array: [{"type":"text","text":"..."}]
    if (Array.isArray(parsed)) {
      for (const block of parsed) {
        if (block?.type === "text" && typeof block.text === "string") {
          try {
            const inner = JSON.parse(block.text);
            if (inner?.team_name) return inner.team_name;
            if (inner?.name) return inner.name;
          } catch { /* not JSON, try next block */ }
        }
      }
    }
  } catch { /* not valid JSON at all */ }
  // Fallback regex
  const match = output.match(/"team_name"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}
