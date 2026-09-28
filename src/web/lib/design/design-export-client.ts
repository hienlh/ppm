import { api, getAuthToken, projectUrl } from "@/lib/api-client";

/**
 * The browser half of the design exports: fetching a download with the auth header, saving
 * it, the `rel` every new-tab view link carries, and minting the print/standalone view tokens.
 *
 * Two rules hold everywhere here, because the files are AI-authored:
 *  - A Blob is always `application/octet-stream`. A `blob:` URL carries PPM's origin, and some
 *    browsers (iOS Safari) ignore `download` and navigate to it; typed as HTML it would then
 *    run the design's scripts next to PPM's token in `localStorage`. The URL is revoked as
 *    soon as the click has been dispatched and is never offered as a link.
 *  - A view opens in a new tab through a real link carrying {@link NEW_TAB_REL}, so the page
 *    gets no `window.opener` handle on PPM. A `noopener` open cannot report a blocked popup (it
 *    returns nothing either way), which is why the menu renders the view as a link the user
 *    clicks rather than opening it from script and guessing.
 */

export const EXPORT_BLOB_TYPE = "application/octet-stream";
export const NEW_TAB_REL = "noopener noreferrer";

export interface DesignExportFile {
  blob: Blob;
  filename: string;
  /** What the server could not inline, as far as it lists them. */
  warnings: string[];
  /** How many there were in total (the list is capped). */
  warningCount: number;
}

const exportUrl = (projectName: string, slug: string, kind: "zip" | "html", entry?: string): string =>
  `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}/export/${kind}${entry ? `?entry=${encodeURIComponent(entry)}` : ""}`;

function filenameFrom(disposition: string | null, fallback: string): string {
  const name = /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? "";
  return /^[A-Za-z0-9._-]{1,200}$/.test(name) ? name : fallback;
}

function warningList(header: string | null): string[] {
  if (!header) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(header));
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

export async function fetchDesignExport(projectName: string, slug: string, kind: "zip" | "html", entry?: string): Promise<DesignExportFile> {
  const token = getAuthToken();
  const res = await fetch(exportUrl(projectName, slug, kind, entry), {
    headers: { "x-ppm-client": "web", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    let message = `Export failed (HTTP ${res.status})`;
    try {
      const json = (await res.json()) as { error?: unknown };
      if (typeof json.error === "string" && json.error) message = json.error;
    } catch {
      // Not JSON: keep the status line.
    }
    throw new Error(message);
  }
  const raw = await res.blob();
  const count = Number(res.headers.get("X-PPM-Export-Warnings") ?? "0");
  return {
    blob: new Blob([raw], { type: EXPORT_BLOB_TYPE }),
    filename: filenameFrom(res.headers.get("Content-Disposition"), `${slug}.${kind}`),
    warnings: warningList(res.headers.get("X-PPM-Export-Warning-List")),
    warningCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  };
}

/** Save `blob` under `filename`, re-typed as octet-stream whatever it came as. */
export function saveBlobAsFile(blob: Blob, filename: string, doc: Document = document): void {
  const safe = blob.type === EXPORT_BLOB_TYPE ? blob : new Blob([blob], { type: EXPORT_BLOB_TYPE });
  const url = URL.createObjectURL(safe);
  try {
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = NEW_TAB_REL;
    a.style.display = "none";
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
  } finally {
    // The click has started the download; the URL is not needed a moment longer.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export type DesignViewPurpose = "print" | "standalone";

/** A 10-minute, non-refreshable token for the print view or the standalone tab. */
export async function mintDesignView(projectName: string, slug: string, purpose: DesignViewPurpose): Promise<{ url: string; expiresAt: number }> {
  const cap = await api.post<{ url: string; expiresAt: number }>("/api/design-preview", { projectName, slug, purpose });
  if (typeof cap?.url !== "string" || !cap.url.startsWith("/api/design-preview/content/")) {
    throw new Error("The server returned no preview address");
  }
  return { url: cap.url, expiresAt: typeof cap.expiresAt === "number" ? cap.expiresAt : Date.now() };
}
