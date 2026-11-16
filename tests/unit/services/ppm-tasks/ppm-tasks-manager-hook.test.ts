/** Assigning a manager chat switches the project's task store on, through the manager env's hook. */
import { expect, it } from "bun:test";
import "../../../test-setup.ts";
import { join } from "node:path";
import { openTestDb, setDb, setSessionMetadata, setSessionProvider } from "../../../../src/services/db.service.ts";
import { createManagerChats } from "../../../../src/services/assistant-managers/manager-chats.service.ts";
import { projectKey } from "../../../../src/services/project-name-for-path.ts";
import { enableOnManagerAssigned, getTaskProject } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";

it("switches tasks on when a project gets a manager, and not before", async () => {
  setDb(openTestDb());
  const project = { name: "hooked", path: join(process.env.PPM_HOME!, "hooked") };
  const assigned: string[] = [];
  const managers = createManagerChats({
    projects: () => [project],
    findClaudeSession: async () => false,
    changed: () => {},
    now: () => 1_000,
    managerAssigned: async (target) => {
      assigned.push(target.projectKey);
      enableOnManagerAssigned(target.projectKey, target.projectPath);
    },
  });
  const key = projectKey(project.path);
  expect(getTaskProject(key)).toBeNull();
  const id = `chat-${crypto.randomUUID()}`;
  setSessionMetadata(id, project.name, project.path);
  setSessionProvider(id, "claude");
  await managers.assign(project.name, id);
  expect(assigned).toEqual([key]);
  expect(getTaskProject(key)).toMatchObject({ enabled: true, enabledBy: "manager_assign" });
});
