/**
 * Which repository each project's git surfaces are pointed at.
 *
 * A workspace folder is often a container whose *children* are the
 * repositories, and every git surface used to run `git` in the container and
 * report "not a git repository" — which reads as PPM being broken rather than
 * as the repositories being one level down. The server discovers them; this
 * holds the answer and the user's choice.
 *
 * The choice is **device-local**, like `lspEnabled` and `mobileWordWrap` and
 * for the same reason: a phone and a desktop may reasonably be looking at
 * different services in the same workspace, and a server round-trip would make
 * the last device to write win everywhere.
 *
 * The discovery result is cached per project because it costs a directory walk
 * and half a dozen panels ask for it independently. `reload` is the escape
 * hatch for "I just cloned something in there".
 */
import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import { resolveRepo, type GitRepoDiscovery } from "@/lib/git-repo-scope";

const STORAGE_KEY = "ppm-git-repo-choice";

function loadChoices(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {}; // private mode, or somebody's extension wrote junk into the key
  }
}

function saveChoices(choices: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Out of quota or blocked: the choice still applies for this session.
  }
}

/** projectName → the discovery request in flight, so callers can await it. */
const inflight = new Map<string, Promise<void>>();

interface GitRepoStore {
  /** projectName → what the server found. */
  discovery: Record<string, GitRepoDiscovery>;
  /** projectName → chosen repository path. */
  chosen: Record<string, string>;
  /** projectName → a request is in flight. */
  loading: Record<string, boolean>;
  /** Fetch once per project unless `force`. */
  load: (projectName: string, force?: boolean) => Promise<void>;
  choose: (projectName: string, repoPath: string) => void;
}

export const useGitRepoStore = create<GitRepoStore>((set, get) => ({
  discovery: {},
  chosen: loadChoices(),
  loading: {},

  load: async (projectName, force = false) => {
    if (!force && get().discovery[projectName]) return;
    // The promise is shared, not just flagged: `resolveGitRoot` awaits this to
    // answer, and a boolean "already loading" would have it return the
    // unscoped path while the answer was one tick away.
    const existing = inflight.get(projectName);
    if (existing && !force) return existing;
    set((s) => ({ loading: { ...s.loading, [projectName]: true } }));
    const request = (async () => {
      try {
        const data = await api.get<GitRepoDiscovery>(`${projectUrl(projectName)}/git/repos`);
        set((s) => ({ discovery: { ...s.discovery, [projectName]: data } }));
      } catch {
        // A project whose directory has gone, or an offline tab. Leaving the
        // entry absent keeps the surfaces in their loading state rather than
        // asserting "no repository here", which would be a guess.
      } finally {
        inflight.delete(projectName);
        set((s) => ({ loading: { ...s.loading, [projectName]: false } }));
      }
    })();
    inflight.set(projectName, request);
    return request;
  },

  choose: (projectName, repoPath) => {
    set((s) => {
      const chosen = { ...s.chosen, [projectName]: repoPath };
      saveChoices(chosen);
      return { chosen };
    });
  },
}));

/**
 * The repository to hand an extension command, for callers outside React.
 *
 * The keybinding handler, the command palette and the webview's recovery
 * dispatch all pass a path as the command's first argument, and none of them is
 * in a position to use a hook. Discovery is awaited rather than sampled: these
 * are one-shot dispatches, so reading a not-yet-loaded store would hand over
 * the container folder and the panel would open on something that is not a
 * repository.
 */
export async function resolveGitRoot(projectName: string, projectPath: string): Promise<string> {
  await useGitRepoStore.getState().load(projectName);
  const { discovery, chosen } = useGitRepoStore.getState();
  return resolveRepo(discovery[projectName], chosen[projectName])?.path ?? projectPath;
}
