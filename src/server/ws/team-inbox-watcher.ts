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

/** Start watching a team's inboxes directory + config.json for changes */
export function startTeamInboxWatcher(
  teamName: string,
  callbacks: WatcherCallbacks,
): { watchers: FSWatcher[]; cleanup: () => void } {
  const inboxDir = join(TEAMS_DIR, teamName, "inboxes");
  const configPath = join(TEAMS_DIR, teamName, "config.json");
  const watchers: FSWatcher[] = [];
  const inboxSnapshots = new Map<string, number>(); // filename → last known msg count
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

/** List all teams from ~/.claude/teams/ */
export async function listTeams(): Promise<unknown[]> {
  try {
    const entries = await readdir(TEAMS_DIR, { withFileTypes: true });
    const teams = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const config = await readTeamConfig(entry.name);
      if (config) teams.push(config);
    }
    return teams;
  } catch { return []; }
}

/** Read team detail with merged inbox messages + inferred member status */
export async function readTeamDetail(teamName: string): Promise<unknown | null> {
  const config = await readTeamConfig(teamName) as any;
  if (!config) return null;

  const inboxDir = join(TEAMS_DIR, teamName, "inboxes");
  const messages: unknown[] = [];
  let inboxFiles: string[] = [];
  try {
    inboxFiles = (await readdir(inboxDir)).filter(f => f.endsWith(".json"));
    for (const file of inboxFiles) {
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
    }
  } catch { /* no inboxes dir */ }

  // Sort by timestamp
  messages.sort((a: any, b: any) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Infer member status from inboxes
  const members = (config.members ?? []).map((m: any) => ({
    ...m,
    status: inferMemberStatus(messages, m.name),
  }));

  // Discover additional members from inbox filenames (reuse already-read list)
  for (const file of inboxFiles) {
    const name = file.replace(".json", "");
    if (!members.some((m: any) => m.name === name)) {
      members.push({
        name,
        agentId: `${name}@${teamName}`,
        agentType: "teammate",
        model: "unknown",
        status: inferMemberStatus(messages, name),
      });
    }
  }

  return { ...config, members, messages, memberCount: members.length };
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

/** Extract team name from TeamCreate tool_result output */
export function extractTeamName(output: string): string | null {
  try {
    const parsed = JSON.parse(output);
    return parsed?.team_name ?? parsed?.name ?? null;
  } catch {
    // Try regex: look for team_name in text
    const match = output.match(/"team_name"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  }
}
