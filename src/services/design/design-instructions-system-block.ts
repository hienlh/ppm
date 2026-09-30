import { DEFAULT_SYSTEM_ID } from "./design-systems-paths.ts";

/** The subset of a design's app the instructions need; kept narrow so a caller need not load the rest. */
export interface DesignInstructionsSystem {
  id: string;
  label: string;
  root: string;
  platform: "web" | "mobile";
}

/**
 * The "design system" section of a design session's instructions, aimed at the design's own
 * app: where to read its `DESIGN.md`/`tokens.css`/kit on disk (the legacy `designs/` root for
 * `default`, `designs/systems/<id>/` for every other app), the `../systems/<id>/…` form to
 * link them from the canvas, where the app's real source lives, and whether it is mobile.
 */
export function designSystemInstructionsBlock(system: DesignInstructionsSystem): string {
  const fsPrefix = system.id === DEFAULT_SYSTEM_ID ? "designs/" : `designs/systems/${system.id}/`;
  const previewPrefix = `../systems/${system.id}`;
  const rootHint = system.root === "." ? "the project root" : `\`${system.root}\` (relative to the project root)`;
  const platformHint = system.platform === "mobile"
    ? "This app is mobile (React Native or similar): show the design in the phone frame and build it with native-looking components, not web chrome."
    : "This app is a web app.";

  return `## The design system (${system.label})
- Before your first change, read \`${fsPrefix}DESIGN.md\` if it exists. It describes this
  app's visual language (colours, type, spacing, components) and, once set up, a
  \`## Screens and components\` map from each screen or component to its real source files.
  Follow it.
- If \`${fsPrefix}tokens.css\` exists, link it from the page with a relative path
  (\`<link rel="stylesheet" href="${previewPrefix}/tokens.css">\`) and use its custom
  properties rather than hard-coding the same values again.
- If \`${fsPrefix}kit/app.css\` exists, link it too (\`<link rel="stylesheet" href="${previewPrefix}/kit/app.css">\`)
  and build the markup with the app's own class names, not new utility classes the compiled
  CSS does not have; use \`${previewPrefix}/kit/icons/<name>.svg\` for icons rather than
  inventing your own. When the request is, or touches, a screen that already exists in the
  app, read the source files the component map lists for it first and reproduce that
  structure faithfully before changing anything — do not invent app chrome (navigation,
  headers, layout) that is not in the source. For something genuinely new the kit has no
  classes for, add a small \`<style>\` block in the design rather than a class the compiled
  CSS lacks.
- This app's real source lives at ${rootHint} — read it there to check how a screen is
  really built, or anything else that helps the design match the product. ${platformHint}
- If the user attached a screenshot of the real app, treat it as the target: after checking
  your work (see below), compare its own screenshot against the one attached and fix visible
  differences — layout, spacing, icons, type — before saying you are done.`;
}
