/**
 * The message that sets up one app's design system, sent (auto-sent, since the user clicked
 * a button asking for exactly this) into that app's showcase design chat.
 *
 * It asks for one read of the app's own codebase and a fixed set of files under
 * `designs/systems/<id>/` (the legacy `designs/` root for the implicit `default` app) —
 * `DESIGN.md`, `tokens.css` and the `kit/` folder — which every design of this app is told
 * to follow and link, plus the app's showcase page at `designs/system-<id>/index.html`. The
 * kit is the app's *real* compiled CSS (not a Tailwind CDN runtime) when it has one, or, for
 * a CSS-in-JS stack, built from its theme sources instead — so a design that links it
 * reproduces the app's actual class names and markup, or its real component recipes, 1:1.
 * Writing anything outside those folders is ruled out explicitly, because this runs in a
 * design session whose permission default auto-approves file edits inside the project —
 * running the app's own build (or reading its existing output) is fine, changing its source
 * is not, and `.env*` contents are never read.
 */

export interface DesignSystemInitTarget {
  id: string;
  label: string;
  /** Relative to the project root; `.` for the project itself. */
  root: string;
  platform: "web" | "mobile";
}

const DEFAULT_SYSTEM_ID = "default";

export function buildDesignSystemInitPrompt(target: DesignSystemInitTarget): string {
  const appRef = target.root === "." ? "this project" : `\`${target.root}/\` in this project`;
  const outDir = target.id === DEFAULT_SYSTEM_ID ? "designs/" : `designs/systems/${target.id}/`;
  const showcaseDir = `designs/system-${target.id}/`;
  const previewPrefix = `../systems/${target.id}`;
  const cssInJsNote = "If it is styled with CSS-in-JS (MUI, antd v5, styled-components, emotion) rather than a "
    + "compiled stylesheet, build `kit/app.css` from its theme sources instead (theme objects, antd tokens / "
    + "`ConfigProvider`, MUI `createTheme`), and in the component map name the library component each kit recipe "
    + "stands for (e.g. antd `<Button type=\"primary\">`), so a later code agent can map a recipe back to it.";
  const mobileNote = target.platform === "mobile"
    ? "This app is mobile (React Native or similar): make the tokens and recipes emulate its native components "
      + "rather than HTML form controls, and build the showcase page to be viewed in the phone frame."
    : "";

  return `Set up the design system for "${target.label}" (${appRef}) so every design for this app matches it.

1. Read ${appRef}'s codebase once to learn its visual language: global stylesheets, theme and
   token files (CSS custom properties, Tailwind config, theme objects), the font setup, and a
   few of the most used UI components (buttons, inputs, cards, navigation). Skip dependencies,
   build output and generated files. Never read \`.env*\` file contents.

2. Write \`${outDir}DESIGN.md\`, a concise guide for designing screens for this app:
   - brand character and tone in a few sentences;
   - the colour palette with roles (background, surface, text, muted text, accent, border,
     success, warning, danger), each with its value, for light and dark mode if both exist;
   - typography: font families, the type scale, weights and line heights;
   - spacing scale, corner radii, shadows and borders;
   - the look of the core components, with the class names or markup patterns the code uses;
   - layout conventions (widths, grids, breakpoints) and any do's and don'ts you noticed.

3. Write \`${outDir}tokens.css\` with a single \`:root { ... }\` block declaring those values as
   CSS custom properties with clear names (\`--color-accent\`, \`--radius-md\`, \`--space-4\`,
   \`--font-body\`...), plus a \`@media (prefers-color-scheme: dark)\` block if the app has a
   dark theme. Plain CSS only: no imports, no build step, no framework syntax.

4. Build the app (or find its existing build output) and copy its real, compiled CSS into
   \`${outDir}kit/app.css\`. Rewrite any \`url(...)\` it uses for fonts to point at files you copy
   alongside it under \`${outDir}kit/fonts/\`. If the app has no CSS build step at all,
   hand-assemble \`${outDir}kit/app.css\` from its real stylesheets instead — it must still be
   the actual rules the app uses, not a guess. ${cssInJsNote} Prefer an existing build output
   or a build that needs no env file, and ask me before running one that needs secrets. Never
   edit the app's own source or build output; only read it and copy files into \`${outDir}kit/\`.

5. Extract the icons the app actually uses (as real SVG artwork, one file per icon) into
   \`${outDir}kit/icons/<name>.svg\`.

6. Add a \`## Screens and components\` section to \`${outDir}DESIGN.md\`: for each of the app's
   main screens and reusable components, list its source file path(s) and a short markup
   snippet using the real class names and icons from the kit, so a design session can find
   and reproduce it faithfully.

7. Build the showcase page at \`${showcaseDir}index.html\`: link it with
   \`<link rel="stylesheet" href="${previewPrefix}/tokens.css">\` and, if you built one,
   \`<link rel="stylesheet" href="${previewPrefix}/kit/app.css">\`, then lay out the colour
   palette, the type scale, the spacing scale, and a handful of the app's main screens or components
   reproduced with the kit, so I can judge how well it matches at a glance. ${mobileNote}

Take the values from the code rather than inventing them, and say where you are unsure.
Create or change only \`${outDir}DESIGN.md\`, \`${outDir}tokens.css\`, files under
\`${outDir}kit/\`, and \`${showcaseDir}\`: do not modify any other file in the project,
especially not ${appRef}'s own source. Running this again replaces what it already produced;
nothing here re-syncs on its own.`;
}
