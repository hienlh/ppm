import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact, fact } from "./assistant-approval-summary.ts";

/**
 * The approval cards of `project_update` and `project_remove`. Pure: built from the project as
 * PPM lists it and the checked arguments, never from anything the agent said about its request.
 * Folders are shown whole, since a cut path could name another folder.
 */

export interface ProjectUpdateApproval {
  project: { name: string; path: string; color?: string | null };
  /** Present only when it differs from the current one. */
  newName?: string;
  newPath?: string;
  /** `null` clears the colour; absent leaves it. */
  color?: string | null;
}

export const PROJECT_MOVE_WARNING = "Chats, terminals and the Assistant work in the new folder from now on; the old folder is left as it is.";

export function projectUpdateSummary(input: ProjectUpdateApproval): ApprovalSummary {
  const { project, newName, newPath } = input;
  const headline = newName && newPath
    ? `Rename project "${project.name}" to "${newName}" and move it to ${newPath}`
    : newName ? `Rename project "${project.name}" to "${newName}"`
      : newPath ? `Move project "${project.name}" to ${newPath}`
        : `Change the colour of project "${project.name}"`;
  const facts = [
    exactFact("Project", project.name),
    exactFact("Folder now", project.path),
    ...(newName ? [exactFact("New name", newName)] : []),
    ...(newPath ? [exactFact("New folder", newPath, "warning")] : []),
    ...(input.color !== undefined ? [fact("Colour", input.color === null ? "None (cleared)" : input.color)] : []),
  ];
  return { headline, facts, ...(newPath ? { warning: PROJECT_MOVE_WARNING } : {}) };
}

/** What deleting a project's row takes with it (`ON DELETE CASCADE` from `projects`). */
export const PROJECT_REMOVE_CASCADE: readonly string[] = [
  "its Jira connection settings", "its Jira watchers", "the issues those watchers found",
];

export interface ProjectRemoveApproval {
  project: { name: string; path: string };
  git: boolean;
  managerChat: boolean;
}

export function projectRemoveSummary(input: ProjectRemoveApproval): ApprovalSummary {
  return {
    headline: `Remove project "${input.project.name}" from PPM`,
    facts: [
      exactFact("Folder", input.project.path),
      fact("Git repository", input.git ? "Yes" : "No"),
      ...(input.managerChat ? [fact("Manager chat", "Yes")] : []),
    ],
    warning: "Files on disk and chat transcripts stay. PPM forgets the project, and deletes its Jira settings "
      + `and watchers: ${PROJECT_REMOVE_CASCADE.join(", ")}.`,
  };
}
