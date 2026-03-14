import type { ProjectService } from "../../services/project.service.ts";
import type { Project } from "../../types/project.ts";

export function resolveProject(
  projectService: ProjectService,
  nameOrPath?: string
): Project {
  return projectService.resolve(nameOrPath);
}
