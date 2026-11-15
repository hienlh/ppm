import { DESIGN_SCREENSHOT_TOOL } from "../../shared/session-collab.ts";
import { isValidDesignSlug } from "../design/design-slug.ts";
import { MAX_SHOTS_PER_CALL } from "../design/shots/design-shots.service.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { projectFor, type CollabCaller, type CollabEnv } from "./collab-context.ts";

/**
 * `design_screenshot`: PNG pictures of a design's variants, rendered on the server. The calling
 * AI sees them (image blocks, while they fit), and gets for each an id it can put on a
 * `report_to_assistant` card — which sends the pictures to the user's Telegram — and a link that
 * shows it from anywhere PPM is reachable.
 *
 * Only a design of a project the caller reaches: its own, or for the PPM Assistant the one it
 * names. One capture runs at a time in the whole server, since each starts a browser.
 */

/** Largest picture shown to the AI inline; a bigger one is reachable by its link only. */
const MAX_INLINE_BYTES = 1_500_000;
/** Largest total of inline pictures in one result. */
const MAX_INLINE_TOTAL = 4_000_000;

let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
};

export function designShotToolDefinition() {
  return {
    name: DESIGN_SCREENSHOT_TOOL,
    title: "Screenshot a design",
    description:
      "Render the variants (pages) of an existing design of this project to PNG, the way the page looks in a browser "
      + "1280 px wide, and return the pictures with an id and a link for each. Use it to look at what a Design chat built, "
      + "and to show the user: a manager chat puts the ids in `report_to_assistant`'s `images`, and PPM sends those pictures "
      + "to the user's phone with the card. Every variant by default, at most " + MAX_SHOTS_PER_CALL + " per call. "
      + "Links stop working after seven days. Web fonts and images from other sites may come out substituted.",
    inputSchema: {
      type: "object",
      properties: {
        design: { type: "string", description: "The design's slug: its folder under designs/." },
        variants: {
          type: "array", items: { type: "string" }, maxItems: MAX_SHOTS_PER_CALL,
          description: "The variant files to render (e.g. \"index.html\", \"variant-2.html\"); all by default.",
        },
        project: { type: "string", description: "PPM Assistant only: the registered project the design belongs to." },
      },
      required: ["design"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

export async function designShotTool(env: CollabEnv, caller: CollabCaller, args: Json): Promise<Json> {
  if (!env.captureDesignShots || !env.shotLink) return textResult("Design screenshots are not available here.", true);
  if (!isValidDesignSlug(args.design)) return textResult("`design` must be a design's slug: the name of its folder under designs/.", true);
  const variants = args.variants;
  if (variants !== undefined && (!Array.isArray(variants) || variants.length > MAX_SHOTS_PER_CALL
    || !variants.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200))) {
    return textResult(`\`variants\` is a list of at most ${MAX_SHOTS_PER_CALL} variant file names.`, true);
  }
  const project = projectFor(env, caller, args.project);
  if (typeof project === "string") return textResult(project, true);

  let shots;
  try {
    shots = await oneAtATime(() => env.captureDesignShots!(project.path, args.design as string, variants as string[] | undefined));
  } catch (e) {
    return textResult(`No screenshot was taken: ${(e as Error).message}`, true);
  }
  const listed = await Promise.all(shots.map(async (s) => ({
    id: s.id, design: s.slug, file: s.file, label: s.label, width: s.width, height: s.height, link: await env.shotLink!(s.id),
  })));
  const content: Json[] = [{
    type: "text",
    text: JSON.stringify({ project: project.name, shots: listed }, null, 2),
  }];
  let total = 0;
  for (const s of shots) {
    if (s.png.byteLength > MAX_INLINE_BYTES || total + s.png.byteLength > MAX_INLINE_TOTAL) continue;
    total += s.png.byteLength;
    content.push({ type: "text", text: `${s.file}${s.label ? ` (${s.label})` : ""}:` });
    content.push({ type: "image", data: Buffer.from(s.png).toString("base64"), mimeType: "image/png" });
  }
  return { content };
}
