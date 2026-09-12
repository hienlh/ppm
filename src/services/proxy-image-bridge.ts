/**
 * OpenAI Images API over a PPM provider's agent.
 *
 *   POST /proxy/<provider>/v1/images/generations   text → image
 *   POST /proxy/<provider>/v1/images/edits         image → image
 *
 * Only codex is wired up, and that is the honest shape of it rather than a
 * shortcut: codex owns a built-in image tool, while Claude cannot generate
 * images at all. Other providers get a clear refusal instead of a hang.
 *
 * Getting the bytes back is the awkward part. The agent's sandbox stays
 * read-only — a proxy reachable with an API key must not gain write access to
 * the host — so it cannot drop the file somewhere of our choosing. It does
 * write into codex's own `generated_images` directory even under that sandbox,
 * so the bridge snapshots that directory around the turn and takes whatever is
 * new. Widening the sandbox to control the path was tried and rejected: codex
 * reports the workspace as read-only regardless, and the elevation would buy
 * nothing.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { resolveCodexAccountForSession } from "./codex-account.service.ts";
import { startAgentTurn, resolveProvider } from "./proxy-agent-turn.ts";
import { openAiError } from "./proxy-openai-format.ts";

/** Providers whose agent can actually produce an image. */
const IMAGE_CAPABLE = new Set(["codex"]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface ImageGenerationBody {
  prompt?: string;
  n?: number;
  size?: string;
  model?: string;
}

export interface ImageEditBody extends ImageGenerationBody {
  /** Data URL or bare base64 of the image to edit. */
  image?: string;
}

/** Decode a data URL (or bare base64) into bytes plus a file extension. */
export function decodeImagePayload(payload: string): { bytes: Buffer; ext: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(payload.trim());
  const mime = match?.[1] ?? "image/png";
  const data = match ? match[3]! : payload.trim();
  const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
  return { bytes: Buffer.from(data, "base64"), ext };
}

/** Every image file under a directory tree, with its modified time. */
function listImages(root: string): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) found.set(full, stat.mtimeMs);
    }
  };
  walk(root);
  return found;
}

/** Where the provider drops generated images. Codex writes under its CODEX_HOME. */
async function imageOutputRoot(): Promise<string> {
  const account = await resolveCodexAccountForSession();
  const home = account?.home ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex");
  return join(home, "generated_images");
}

/** Run one turn and return the image files it produced, newest first. */
async function runImageTurn(
  providerId: string, prompt: string, model: string | undefined, imagePaths: string[],
): Promise<string[]> {
  const root = await imageOutputRoot();
  mkdirSync(root, { recursive: true });
  const before = listImages(root);

  const { events, cleanup } = await startAgentTurn(providerId, { prompt, model, imagePaths });
  let said = "";
  try {
    for await (const ev of events) {
      if (ev.type === "text") said += ev.content;
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "done") break;
    }
  } finally {
    await cleanup();
  }

  const produced = [...listImages(root)]
    .filter(([path, mtime]) => !before.has(path) || before.get(path) !== mtime)
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);

  if (produced.length === 0) {
    // The agent answers in prose when it declines, and that reason is far more
    // useful to the caller than a bare "no image".
    throw new Error(`The agent produced no image. It replied: ${said.trim().slice(0, 400) || "(nothing)"}`);
  }
  return produced;
}

/** OpenAI's images response. Always base64 — PPM has nowhere to host a URL. */
function imagesResponse(paths: string[]): Response {
  return new Response(JSON.stringify({
    created: Math.floor(Date.now() / 1000),
    data: paths.map((p) => ({ b64_json: readFileSync(p).toString("base64") })),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/** Shared guard: provider must exist and be able to make images. */
function refuse(providerId: string): Response | null {
  if (!resolveProvider(providerId)) return openAiError(404, `Unknown provider "${providerId}"`);
  if (!IMAGE_CAPABLE.has(providerId)) {
    return openAiError(400, `Provider "${providerId}" cannot generate images. Supported: ${[...IMAGE_CAPABLE].join(", ")}`);
  }
  return null;
}

/** Ask for exactly the files we intend to read back. */
function generationPrompt(body: ImageGenerationBody): string {
  const count = Math.min(Math.max(body.n ?? 1, 1), 4);
  return [
    `Generate ${count} image${count > 1 ? "s" : ""} using your built-in image generation tool.`,
    body.size ? `Target size: ${body.size}.` : "",
    `Subject: ${body.prompt}`,
    "Do not write any files yourself and do not run shell commands. Reply with only the word DONE.",
  ].filter(Boolean).join("\n");
}

/** POST /v1/images/generations */
export async function forwardImageGeneration(providerId: string, body: ImageGenerationBody): Promise<Response> {
  const blocked = refuse(providerId);
  if (blocked) return blocked;
  if (!body.prompt?.trim()) return openAiError(400, "prompt is required");

  try {
    const produced = await runImageTurn(providerId, generationPrompt(body), body.model, []);
    return imagesResponse(produced.slice(0, Math.min(Math.max(body.n ?? 1, 1), 4)));
  } catch (e) {
    return openAiError(502, (e as Error).message);
  }
}

/** POST /v1/images/edits */
export async function forwardImageEdit(providerId: string, body: ImageEditBody): Promise<Response> {
  const blocked = refuse(providerId);
  if (blocked) return blocked;
  if (!body.image) return openAiError(400, "image is required");
  if (!body.prompt?.trim()) return openAiError(400, "prompt is required");

  // The agent reads the source off disk, so the payload has to land somewhere
  // first; the directory is this request's alone and goes away with it.
  const dir = mkdtempSync(join(tmpdir(), "ppm-img-in-"));
  try {
    const { bytes, ext } = decodeImagePayload(body.image);
    if (bytes.length === 0) return openAiError(400, "image is not valid base64");
    const path = join(dir, `input${ext}`);
    writeFileSync(path, bytes);

    const prompt = [
      "Edit the attached image using your built-in image generation tool.",
      `Requested change: ${body.prompt}`,
      "Preserve everything the request does not ask you to change.",
      "Do not write any files yourself and do not run shell commands. Reply with only the word DONE.",
    ].join("\n");

    const produced = await runImageTurn(providerId, prompt, body.model, [path]);
    return imagesResponse(produced.slice(0, Math.min(Math.max(body.n ?? 1, 1), 4)));
  } catch (e) {
    return openAiError(502, (e as Error).message);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
