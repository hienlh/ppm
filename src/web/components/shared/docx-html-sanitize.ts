import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

/**
 * What a converted `.docx`'s HTML may keep. mammoth does no sanitising, so a `javascript:`
 * hyperlink in a document (verified: one click read the auth token from the page) reaches the
 * preview's `innerHTML` as a live link, and a `<script>` smuggled through a document would run.
 * The preview has no `markdownUrlTransform`, so unlike the Markdown path the scheme check is
 * done here: links keep http(s)/mailto, images keep http(s) and the `data:` URIs mammoth
 * inlines its embedded pictures as. Starts from GitHub's allow-list, so headings, bold/italic,
 * lists, tables and images survive.
 *
 * This is its own file rather than part of `markdown-sanitize.ts` so the Markdown renderer's
 * chunk does not carry rehype-parse/rehype-stringify, which only the lazy docx preview needs.
 */
export const docxSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "src", "width", "height"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https", "data"],
    href: ["http", "https", "mailto"],
  },
};

interface HastNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * The allow-list keeps any `data:` image src, but hast-util-sanitize checks only the `data:`
 * prefix — so `data:text/html,…` survives. An `<img>` cannot run it, yet it has no business in
 * a document, so this drops every `data:` src that is not `data:image/`.
 */
function dropNonImageDataSrc(node: HastNode): void {
  const src = node.tagName === "img" ? node.properties?.src : undefined;
  if (typeof src === "string" && /^data:/i.test(src) && !/^data:image\//i.test(src)) {
    delete node.properties!.src;
  }
  node.children?.forEach(dropNonImageDataSrc);
}

const docxPipeline = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, docxSanitizeSchema)
  .use(() => (tree: unknown) => dropNonImageDataSrc(tree as HastNode))
  .use(rehypeStringify);

/** Hold HTML from an untrusted document to the docx allow-list before it reaches `innerHTML`. */
export function sanitizeDocxHtml(html: string): string {
  return String(docxPipeline.processSync(html));
}
