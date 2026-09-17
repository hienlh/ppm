/**
 * Dispatch an extension command with the path it should run in.
 *
 * Every dispatch site used to push `activeProject.path` inline. That is still
 * the right argument for most extensions, but a git view has to be handed the
 * *repository* — which in a container workspace is a subfolder the user picked,
 * and running the graph in the container reports "not a git repository". The
 * decision is one place rather than three, because a site that forgets it fails
 * only for that one entry point and looks like the feature working "sometimes".
 */
import { commandRunsGit } from "@/lib/git-repo-scope";
import { resolveGitRoot } from "@/stores/git-repo-store";
import { useProjectStore } from "@/stores/project-store";

export async function dispatchExtCommand(command: string): Promise<void> {
  const project = useProjectStore.getState().activeProject;
  const args: unknown[] = [];
  if (project?.path) {
    args.push(
      commandRunsGit(command) ? await resolveGitRoot(project.name, project.path) : project.path,
    );
  }
  window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command, args } }));
}
