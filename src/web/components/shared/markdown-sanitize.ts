import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

/**
 * What HTML inside Markdown may become once rehype-raw has parsed it. The app shell has no CSP
 * and keeps the auth token in `localStorage`, so anything that can run script, navigate the
 * page, load a document or restyle the app is dropped: `<iframe srcdoc>`, `<script>`, `on*`
 * handlers, `<svg onload>`, `<form>`, `<object>`, `<embed>`, `<meta http-equiv>`, `<base>`,
 * `<style>`, `style=` and arbitrary `class=` (Tailwind classes alone can lay a fake screen over
 * the app). An element not listed is unwrapped, so its text still shows.
 *
 * It starts from GitHub's allow-list (rehype-sanitize's default), which already covers GFM:
 * tables, task-list checkboxes (forced disabled), footnotes, `<details>`, `<kbd>`, `<sub>`,
 * `<sup>`, `<br>`, images and links.
 *
 * URLs are deliberately not checked here. `markdownUrlTransform` runs over every element's
 * URL attributes after the plugins, raw HTML included, and is the one place that decides which
 * destinations are allowed — it has to keep `README.md:5` and `C:\x.png`, which a scheme
 * allow-list reads as the schemes `readme.md` and `c` and would delete.
 *
 * KaTeX and Shiki add their markup after this runs (rehype-katex is the next plugin, Shiki
 * renders inside the code-block component), so neither needs anything allowed here beyond the
 * classes remark-math puts on the code it hands to rehype-katex.
 */
export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), "style"],
  tagNames: [...(defaultSchema.tagNames ?? []), "abbr", "mark", "small", "u"],
  // `<source>` is only on the list for `<picture>`; anywhere else it is a media loader.
  ancestors: { ...defaultSchema.ancestors, source: ["picture"] },
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: { cite: ["http", "https"], longDesc: ["http", "https"] },
};

const CLOBBER_PREFIX = defaultSchema.clobberPrefix ?? "user-content-";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function prefixFragments(node: HastNode): void {
  const href = node.tagName === "a" ? node.properties?.href : undefined;
  if (typeof href === "string" && href.length > 1 && href.startsWith("#")) {
    node.properties!.href = `#${CLOBBER_PREFIX}${href.slice(1)}`;
  }
  node.children?.forEach(prefixFragments);
}

/**
 * The sanitiser prefixes every `id` and `name` (a bare `id="config"` would otherwise become
 * `window.config`), but not the `#fragment` links that point at them, so footnotes and in-page
 * anchors stopped landing anywhere. This prefixes those links the same way. It needs
 * remark-rehype's own footnote prefix turned off, or footnote ids get the prefix twice.
 */
export function rehypePrefixFragmentLinks() {
  return (tree: HastNode) => prefixFragments(tree);
}

/** remark-rehype options for the sanitised pipeline: the sanitiser adds the id prefix. */
export const sanitizedRemarkRehypeOptions = { clobberPrefix: "" };
