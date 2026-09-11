/**
 * Models for files the user has not opened.
 *
 * When a server answers "the definition is in `other.ts` line 40", Monaco can
 * only act on that if a model exists for that URI. Without one, F12 across
 * files does nothing at all and the peek widget opens empty — the single most
 * conspicuous way an editor can feel broken, because the feature appears to
 * work right up to the point it matters.
 *
 * There is no public way to give standalone Monaco a model *resolver*, so the
 * models are created ahead of time instead: a provider that is about to return
 * locations first makes sure a model exists for each of them. Monaco then finds
 * them by URI and renders peek, go-to-definition and find-all-references
 * natively, with no per-feature code.
 *
 * They are called shadow models because nothing shows them: no tab, no editor.
 * They exist only to be resolved by URI, so they are capped and evicted — the
 * contents of every file ever referenced would otherwise accumulate for the
 * life of the page.
 */
import type * as MonacoType from "monaco-editor";
import { api, projectUrl } from "@/lib/api-client";
import { fileUriToPath } from "../../../shared/lsp-uri";

/** How many unopened files to keep resolvable at once. */
const MAX_SHADOW_MODELS = 40;

/** Insertion-ordered, so the oldest is the first key. */
const shadows = new Map<string, MonacoType.editor.ITextModel>();

/** URIs already known to be unfetchable, so a miss is not retried per keystroke. */
const failed = new Set<string>();

function relativeTo(projectPath: string, absolute: string): string | null {
  const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = absolute.replace(/\\/g, "/");
  if (!path.startsWith(root + "/")) return null;
  return path.slice(root.length + 1);
}

/**
 * Make sure a model exists for each URI, fetching contents as needed.
 *
 * Failures are swallowed: a location can legitimately point outside the project
 * (into `node_modules`, or a library shipped with the toolchain), and losing
 * one entry of a reference list is much better than failing the provider and
 * losing all of them.
 */
export async function ensureShadowModels(
  monaco: typeof MonacoType,
  projectName: string,
  projectPath: string,
  uris: string[],
): Promise<void> {
  if (!projectPath) return;

  const wanted = [...new Set(uris)].filter((uri) => {
    if (failed.has(uri)) return false;
    if (shadows.has(uri)) return false;
    // A URI the user has open already has a real model; the bridge rewrites
    // those to the model's own URI, so anything still `file:` is unopened.
    return uri.startsWith("file:") && !monaco.editor.getModel(monaco.Uri.parse(uri));
  });
  if (wanted.length === 0) return;

  await Promise.all(wanted.map(async (uri) => {
    const absolute = fileUriToPath(uri);
    const relative = absolute ? relativeTo(projectPath, absolute) : null;
    if (!relative) {
      failed.add(uri);
      return;
    }
    try {
      const result = await api.get<{ content?: string }>(
        `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(relative)}`,
      );
      const content = result?.content;
      if (typeof content !== "string") {
        failed.add(uri);
        return;
      }
      const parsed = monaco.Uri.parse(uri);
      // Another provider may have created it while this fetch was in flight.
      if (monaco.editor.getModel(parsed)) return;
      // Language is left undefined so Monaco infers it from the URI's
      // extension, which is what gives the peek widget its highlighting.
      shadows.set(uri, monaco.editor.createModel(content, undefined, parsed));
      evict();
    } catch {
      failed.add(uri);
    }
  }));
}

function evict(): void {
  while (shadows.size > MAX_SHADOW_MODELS) {
    const oldest = shadows.keys().next().value as string | undefined;
    if (!oldest) return;
    const model = shadows.get(oldest);
    shadows.delete(oldest);
    // Disposing a model Monaco is currently showing in a peek widget would
    // blank it, but a shadow model is never the active editor's model, so the
    // only reader is a widget that has already rendered.
    try {
      model?.dispose();
    } catch {
      // Already disposed.
    }
  }
}

/** Drop every shadow model, for when the last editor for a project closes. */
export function disposeShadowModels(): void {
  for (const model of shadows.values()) {
    try {
      model.dispose();
    } catch {
      // Already disposed.
    }
  }
  shadows.clear();
  failed.clear();
}
