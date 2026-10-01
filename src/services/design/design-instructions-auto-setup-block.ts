import { DEFAULT_SYSTEM_ID } from "./design-systems-paths.ts";
import { buildDesignSystemInitPrompt, type DesignSystemInitTarget } from "../../shared/design-system-init-prompt.ts";

/**
 * Added to a design's per-turn instructions only while its app has no `DESIGN.md` yet: most
 * users do not know what a design system is, so nothing should ask them — the agent sets it
 * up itself, in this same turn, before building what was actually asked for.
 *
 * The setup steps are `buildDesignSystemInitPrompt`'s own text, embedded verbatim (never
 * copied into prose here), so the brief a user gets from the canvas "Set up design system"
 * button and the one an agent follows here can never drift apart. This wrapper only adds the
 * one-line user notice, the turn order (`design-instructions.ts` places it after the
 * clarifying-questions guidance and before anything about building), and the one explicit
 * exception to "Where to work" this turn needs — that section otherwise restricts an
 * unprompted write to outside the design's own folder.
 *
 * Gone for good once `DESIGN.md` exists: `buildDesignInstructions` stops calling this the
 * moment `hasDesignMd` is true, so a later turn — even a small edit — never sees it again,
 * and the stale "Refresh design system" flow (re-running the same brief by hand from the
 * showcase chat or the canvas More menu) is untouched by it.
 */
export function designAutoSetupBlock(target: DesignSystemInitTarget): string {
  const outDir = target.id === DEFAULT_SYSTEM_ID ? "designs/" : `designs/systems/${target.id}/`;
  const showcaseDir = `designs/system-${target.id}/`;
  return `## This app has no design system yet
Before your first build, set it up yourself, in this one turn — do not ask the user whether
to do this, and do not wait for them to run it separately.
- Tell the user, in one short line, that you are first setting up "${target.label}"'s design
  system (a one-time step); then do the setup below; then build what they actually asked for,
  using what you just set up.
- The one exception to "Where to work" for this turn: \`${outDir}\` and
  \`${showcaseDir}index.html\` are both writable, with no need to ask first — they are
  outside this design's own folder, but setting the system up is what this turn is for.

${buildDesignSystemInitPrompt(target)}`;
}
