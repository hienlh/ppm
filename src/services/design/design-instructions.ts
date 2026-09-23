import { isValidDesignSlug } from "./design-slug.ts";

/**
 * Hosts the design canvas lets a page load scripts, styles, fonts and images from.
 * Anything else is blocked by the canvas CSP, so the agent is told up front instead of
 * discovering it as a blank preview.
 */
export const DESIGN_INSTRUCTION_CDN_HOSTS = [
  "cdn.tailwindcss.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const;

/**
 * The instruction block a design session carries on every turn (Claude `append`, Codex
 * `developerInstructions`). Server-built from a validated slug only: no client-supplied
 * text reaches the system prompt, which is why an invalid slug throws rather than being
 * escaped.
 */
export function buildDesignInstructions(slug: string): string {
  if (!isValidDesignSlug(slug)) throw new Error(`invalid design slug "${slug}"`);
  const dir = `designs/${slug}/`;
  const cdnList = DESIGN_INSTRUCTION_CDN_HOSTS.map((host) => `  - https://${host}`).join("\n");

  return `# Design mode

This conversation is a design session. You are producing a visual design that the user
previews live in a sandboxed canvas next to this chat. You are not changing the
application's source code.

## Where to work
- Your working directory for this design is \`${dir}\`. Create and edit files only inside it.
- The entry point is \`${dir}index.html\`. It must always exist and render on its own.
- Split out extra files (\`styles.css\`, \`script.js\`, images) inside \`${dir}\` when that keeps
  the page readable. Do not touch files outside \`${dir}\`, except the shared design system
  files described below, and only when the user asks for it.
- Never read, search, list or write anything under a \`.design/\` directory. It holds the
  canvas's own snapshots and comments and is not part of the design.

## The design system
- Before your first change, read \`designs/DESIGN.md\` if it exists. It describes the
  project's visual language (colours, type, spacing, components). Follow it.
- If \`designs/tokens.css\` exists, link it from the page with a relative path
  (\`<link rel="stylesheet" href="../tokens.css">\`) and use its custom properties rather
  than hard-coding the same values again.

## The manifest: \`${dir}design.json\`
- It is a JSON object. Keep the fields it already has. \`kind\` was set when the design was
  created: \`"slides"\` means a slide deck, anything else a single page. Do not change it.
- \`tweaks\` is an array of controls the user can adjust live. Each entry maps one CSS custom
  property (\`var\`, e.g. \`--accent\`) to a control:
  - \`{"id", "label", "type": "range", "var", "min", "max", "step", "unit", "default"}\`
  - \`{"id", "label", "type": "color", "var", "default": "#rrggbb"}\`
  - \`{"id", "label", "type": "select", "var", "options": [{"label", "value"}], "default"}\`
- Declare every tweakable value once in the design's own \`:root { ... }\` block and use it
  through \`var(--name)\`. Never put tweak variables in \`../tokens.css\`.
- Offer a handful of meaningful tweaks (accent colour, radius, spacing scale, font size),
  not one per property.

## Assets and network
- Reference local files with relative paths only (\`./hero.png\`, \`styles.css\`). Absolute
  paths, \`file:\` URLs and paths that climb out of \`${dir}\` (other than \`../tokens.css\`)
  do not resolve in the canvas.
- The canvas may load scripts, styles, fonts and images from these hosts and nowhere else:
${cdnList}
- There is no other network access: \`fetch\`, XHR, WebSockets and third-party embeds are
  blocked. Use inline sample data instead of calling an API.
- Links to other pages or websites do not navigate inside the canvas. Keep the design on
  one page (or one deck) and use in-page anchors or script for interaction.

## Slides
- When \`kind\` is \`"slides"\`, each slide is a \`<section class="slide">\` sized exactly
  1280x720 CSS pixels, stacked in document order. Keep content inside that box; the export
  to PDF and PowerPoint uses one slide per section.

## How to edit
- Prefer small, targeted edits to the existing files over rewriting a whole file. The user
  may have adjusted the page from the canvas, and a full rewrite discards that.
- Keep the markup semantic and the page responsive unless the user asks for a fixed size.
- After a change, say briefly what you changed. The user sees the result in the canvas, so
  there is no need to paste the full file back into the chat.
`;
}
