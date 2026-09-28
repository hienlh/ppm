/**
 * The message that sets up a project's design system, placed in the design chat's composer
 * for the user to review and send (never sent automatically).
 *
 * It asks for one read of the codebase and exactly two files, `designs/DESIGN.md` and
 * `designs/tokens.css`, which every design session is told to follow and link. Writing
 * anything else is ruled out explicitly, because this runs in a design session whose
 * permission default auto-approves file edits inside the project.
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

Take the values from the code rather than inventing them, and say where you are unsure.
Create or change only those two files: do not modify any other file in the project, and do
not create a design folder.`;
}
