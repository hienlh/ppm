/**
 * Export a chat as Markdown (`GET /chat/sessions/:id/export.md`): fetched with the login, then
 * saved under the name the server chose from the chat's title.
 */
import { getAuthToken, projectUrl } from "./api-client";
import { triggerDownload } from "./file-download";

/** The file name a `Content-Disposition` header carries, preferring its UTF-8 form. */
export function dispositionFileName(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through to the plain form */ }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? fallback;
}

export async function exportChatMarkdown(projectName: string, sessionId: string, providerId: string): Promise<void> {
  const url = projectUrl(projectName) + "/chat/sessions/" + encodeURIComponent(sessionId) + "/export.md?providerId=" + encodeURIComponent(providerId);
  const token = getAuthToken();
  const res = await fetch(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Export failed (" + res.status + ")");
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, dispositionFileName(res.headers.get("Content-Disposition"), "chat.md"));
  } finally {
    // The click has started the download; the URL is not needed after this turn of the loop.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
