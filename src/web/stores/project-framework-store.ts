/**
 * Which framework's file-naming convention the active project follows.
 *
 * `app.service.ts` is a NestJS provider in one repository and an Angular
 * service in another, and vscode-icons draws them differently. Upstream leaves
 * that to the user — both sets of artwork ship `disabled: true` behind
 * `vsicons.presets.nestjs` and `vsicons.presets.angular`, and they cannot both
 * be on, because they claim the same six suffixes (`module`, `service`,
 * `guard`, `pipe`, `interceptor`, `controller`). PPM already knows which
 * project a tree belongs to, so it answers the question instead of asking it.
 *
 * The signal is one dependency in `package.json`, which is the only thing that
 * actually settles it: a directory full of `*.module.ts` says nothing, and
 * `nest-cli.json` is absent from plenty of Nest repositories that build with
 * something else. Neither marker present means neither overlay, which is also
 * what VS Code shows with no preset on — the plain TypeScript glyph.
 *
 * One fetch per project, cached for the session. A project whose `package.json`
 * is missing or unparseable is cached as "neither" so a repository without one
 * does not re-ask on every switch.
 */
import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import type { IconFramework } from "@/lib/file-icons.generated";

/** Checked in order, so a repository holding both is read as Nest. */
const MARKERS: readonly (readonly [IconFramework, string])[] = [
  ["nest", "@nestjs/core"],
  ["angular", "@angular/core"],
];

const answered = new Map<string, IconFramework | null>();

/**
 * The project a fetch is in flight for.
 *
 * Module-level rather than read back off the project store, which would make
 * the import cycle `project-store → this → project-store`. All it has to do is
 * drop the answer to a project the user has already switched away from.
 */
let pending: string | null = null;

interface ProjectFrameworkStore {
  framework: IconFramework | null;
  detect: (projectName: string | null) => void;
}

export const useProjectFrameworkStore = create<ProjectFrameworkStore>((set) => ({
  framework: null,

  detect: (projectName) => {
    pending = projectName;
    if (!projectName) {
      set({ framework: null });
      return;
    }
    if (answered.has(projectName)) {
      set({ framework: answered.get(projectName) ?? null });
      return;
    }
    // Neither overlay until the answer lands, rather than the previous
    // project's: a Nest icon on an Angular file is worse than a plain one.
    set({ framework: null });
    api
      .get<{ content: string }>(`${projectUrl(projectName)}/files/read?path=package.json`)
      .then(({ content }) => {
        const pkg = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        return MARKERS.find(([, dep]) => dep in deps)?.[0] ?? null;
      })
      .catch(() => null)
      .then((framework) => {
        answered.set(projectName, framework);
        if (pending === projectName) set({ framework });
      });
  },
}));

/** The overlay `FileIcon` should resolve names through, or `null` for neither. */
export function useIconFramework(): IconFramework | null {
  return useProjectFrameworkStore((s) => s.framework);
}
