import { getAuthToken, projectUrl } from "@/lib/api-client";
import type { TransformProps } from "../../../shared/design-bridge-messages-transform";

/**
 * `/designs/:slug/style` (a move or resize from the canvas) and `/designs/:slug/undo`.
 *
 * Both do their own fetch, like the tweak commit: a 409 and a 429 are expected answers that
 * the canvas reacts to (reload, reselect, slow down, point at History), and the shared
 * client would turn their bodies into a bare `Error`.
 */

export type StylePatchOutcome =
  | { status: "written"; gen: string; undoId: string | null }
  | { status: "stale" | "element-moved"; message: string }
  | { status: "rate-limited"; message: string };

export type UndoOutcome =
  | { status: "undone"; gen: string }
  | { status: "cannot-undo" | "unknown"; message: string };

const base = (projectName: string, slug: string) => `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}`;

async function postJson(url: string, body: unknown): Promise<{ status: number; json: { ok?: boolean; error?: string; data?: Record<string, unknown> } }> {
  const token = getAuthToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  try {
    return { status: res.status, json: await res.json() };
  } catch {
    throw new Error(`Server error (HTTP ${res.status})`);
  }
}

export async function postDesignStyle(
  projectName: string,
  slug: string,
  body: { file: string; gen: string; ppmId: number; tag: string; props: TransformProps },
): Promise<StylePatchOutcome> {
  const { status, json } = await postJson(`${base(projectName, slug)}/style`, body);
  const message = json.error || `HTTP ${status}`;
  if (status === 409 && (json.data?.reason === "stale" || json.data?.reason === "element-moved")) {
    return { status: json.data.reason, message };
  }
  if (status === 429) return { status: "rate-limited", message };
  if (status >= 400 || json.ok === false) throw new Error(message);
  const gen = json.data?.gen;
  const undoId = json.data?.undoId;
  if (typeof gen !== "string") throw new Error("The server did not say what it wrote");
  return { status: "written", gen, undoId: typeof undoId === "string" ? undoId : null };
}

export async function undoDesignEdit(projectName: string, slug: string, undoId: string): Promise<UndoOutcome> {
  const { status, json } = await postJson(`${base(projectName, slug)}/undo`, { undoId });
  const message = json.error || `HTTP ${status}`;
  if (status === 409) return { status: "cannot-undo", message };
  if (status === 404) return { status: "unknown", message };
  if (status >= 400 || json.ok === false) throw new Error(message);
  return { status: "undone", gen: typeof json.data?.gen === "string" ? json.data.gen : "" };
}
