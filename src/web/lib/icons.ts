/**
 * The app's product icons. Import icons from here, never from `lucide-react`.
 *
 * The set is Fluent System Icons at 20px Regular — what
 * `miguelsolorio.fluent-icons` puts over VS Code's own product icons — for the
 * 208 names that have an equivalent, and lucide for the 14 that do not (a brand
 * mark, a `git-commit` glyph Fluent never drew, the search widget's match-case
 * and regex toggles). Mixing two icon sets is the point rather than a
 * compromise: a *wrong* glyph on a toggle is worse than an inconsistent one.
 *
 * Two files behind this: `icons.generated.tsx` holds the path data and every
 * export (`bun scripts/gen-product-icons.ts`), and `fluent-icon.tsx` is the one
 * component they are built from. Adding an icon means adding a line to the
 * script's `MAP` and re-running it, which is also where a name Fluent does not
 * have gets reported instead of quietly rendering nothing.
 */
export * from "./icons.generated";
