import { projectRoute, type CallPpmRoute } from "./assistant-route-rules.ts";

/**
 * Which repository of a project a git tool acts in. A project folder is often a container whose
 * children are the checkouts, so the answer comes from PPM's own discovery (`GET /git/repos`):
 *  - the project folder is a repository → that one, with no `repo` parameter (every URL of an
 *    ordinary project stays exactly what the UI sends);
 *  - the agent named one → only a repository discovery listed, matched by its project-relative
 *    path, and sent as discovery's *absolute* path, because the route resolves `repo` against the
 *    server process's directory, not the project's;
 *  - one repository below the folder → that one; several → never a guess, the caller lists them.
 */

interface Candidate {
  path: string;
  name: string;
  relative: string;
}

interface Discovery {
  root: string;
  rootIsRepo: boolean;
  repos: Candidate[];
  truncated?: boolean;
}

export interface GitRepoScope {
  project: string;
  /** The `repo` query value: undefined for the project folder itself. */
  query: string | undefined;
  /** Absolute path of the repository's working tree. */
  path: string;
  /** Path relative to the project, `.` for the project folder. */
  relative: string;
}

export type GitRepoScopeResult =
  | { ok: true; scope: GitRepoScope }
  /** `repos` is set when the project holds several repositories and none was named. */
  | { ok: false; error: string; repos?: Array<{ relative: string; name: string }> };

const listed = (d: Discovery) => d.repos.map((r) => ({ relative: r.relative, name: r.name }));

export async function resolveGitRepo(call: CallPpmRoute, project: unknown, repoArg: unknown): Promise<GitRepoScopeResult> {
  if (typeof project !== "string" || !project.trim()) {
    return { ok: false, error: "`project` is required: the name of a registered project (see projects_list)." };
  }
  if (repoArg !== undefined && repoArg !== null && (typeof repoArg !== "string" || !repoArg.trim())) {
    return { ok: false, error: "`repo` must be a repository's path relative to the project, as git_status lists it." };
  }
  const res = await call<Discovery>("GET", projectRoute(project, "git/repos"));
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? "PPM could not list the project's repositories." };
  const discovery = res.data;
  const pick = (c: Candidate): GitRepoScopeResult => ({
    ok: true,
    scope: { project, query: discovery.rootIsRepo ? undefined : c.path, path: c.path, relative: c.relative },
  });

  if (typeof repoArg === "string") {
    // Forward or back slashes, with or without a leading "./": the agent may copy either form.
    const wanted = repoArg.trim().replace(/\\/g, "/").replace(/^\.\/(?=.)/, "").replace(/\/+$/, "") || ".";
    const found = discovery.repos.find((r) => r.relative === wanted);
    if (found) return pick(found);
    return {
      ok: false,
      error: `"${repoArg.slice(0, 200)}" is not a repository of "${project}". Name one of those git_status lists.`,
      repos: listed(discovery),
    };
  }
  if (discovery.repos.length === 1) return pick(discovery.repos[0]!);
  if (discovery.repos.length === 0) {
    return { ok: false, error: `"${project}" has no git repository${discovery.truncated ? " that PPM found before its scan limit" : ""}.` };
  }
  return {
    ok: false,
    error: `"${project}" holds ${discovery.repos.length} repositories; pass \`repo\` with one of their relative paths.`,
    repos: listed(discovery),
  };
}
