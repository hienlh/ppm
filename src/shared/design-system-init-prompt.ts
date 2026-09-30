/**
 * The message that sets up a project's design system, placed in the design chat's composer
 * for the user to review and send (never sent automatically).
 *
 * It asks for one read of the codebase and a fixed set of files under `designs/` — `DESIGN.md`,
 * `tokens.css` and the `kit/` folder — which every design session is told to follow and link.
 * The kit is the project's *real* compiled CSS (not a Tailwind CDN runtime), so a design that
 * links it reproduces the app's actual class names and markup 1:1. Writing anything outside
 * `designs/` is ruled out explicitly, because this runs in a design session whose permission
 * default auto-approves file edits inside the project — running the project's own build (or
 * reading its existing output) is fine, changing its source is not.
 */
export function buildDesignSystemInitPrompt(): string {
  return `Set up this project's design system so every design here matches the product.

1. Read the codebase once to learn its visual language: global stylesheets, theme and token
   files (CSS custom properties, Tailwind config, theme objects), the font setup, and a few
   of the most used UI components (buttons, inputs, cards, navigation). Skip dependencies,
   build output and generated files.

2. Write \`designs/DESIGN.md\`, a concise guide for designing screens for this product:
   - brand character and tone in a few sentences;
   - the colour palette with roles (background, surface, text, muted text, accent, border,
     success, warning, danger), each with its value, for light and dark mode if both exist;
   - typography: font families, the type scale, weights and line heights;
   - spacing scale, corner radii, shadows and borders;
   - the look of the core components, with the class names or markup patterns the code uses;
   - layout conventions (widths, grids, breakpoints) and any do's and don'ts you noticed.

3. Write \`designs/tokens.css\` with a single \`:root { ... }\` block declaring those values as
   CSS custom properties with clear names (\`--color-accent\`, \`--radius-md\`, \`--space-4\`,
   \`--font-body\`...), plus a \`@media (prefers-color-scheme: dark)\` block if the product
   has a dark theme. Plain CSS only: no imports, no build step, no framework syntax.

4. Build the project (or find its existing build output) and copy its real, compiled CSS —
   whatever produces the actual class names the app renders with, whether that comes from
   Tailwind, CSS modules, a CSS-in-JS build, or a plain stylesheet — into \`designs/kit/app.css\`.
   Rewrite any \`url(...)\` it uses for fonts to point at files you copy alongside it under
   \`designs/kit/fonts/\`. If the project has no CSS build step at all, hand-assemble
   \`designs/kit/app.css\` from its real stylesheets instead — it must still be the actual
   rules the app uses, not a guess. Never edit the project's own source or build output to do
   this; only read it and copy files into \`designs/kit/\`.

5. Extract the icons the app actually uses (as real SVG artwork, one file per icon) into
   \`designs/kit/icons/<name>.svg\`.

6. Add a \`## Screens and components\` section to \`designs/DESIGN.md\`: for each of the app's
   main screens and reusable components, list its source file path(s) and a short markup
   snippet using the real class names and icons from the kit, so a design session can find
   and reproduce it faithfully.

Take the values from the code rather than inventing them, and say where you are unsure.
Create or change only \`designs/DESIGN.md\`, \`designs/tokens.css\` and files under
\`designs/kit/\`: do not modify any other file in the project. Running this again replaces
what it already produced; nothing here re-syncs on its own.`;
}
