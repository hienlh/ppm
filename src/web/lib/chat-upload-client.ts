/**
 * PPM's upload route for chat files (`POST /chat/upload`) and its undo (`DELETE /chat/uploads/:name`),
 * shared by the chat composer and the cards' voice replies. A recording comes back with the
 * route's receipt, which is what lets a card reply from this screen say it was spoken.
 */
import { getAuthToken, projectUrl } from "@/lib/api-client";

export interface UploadedChatFile {
  path: string;
  /** Given for a recording only (`voice-upload-receipt.ts` on the server). */
  voiceReceipt?: string;
}

function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Uploads one file; null when it did not land. Never throws. */
export async function uploadChatFile(projectName: string, file: File): Promise<UploadedChatFile | null> {
  try {
    const form = new FormData();
    form.append("files", file);
    const res = await fetch(`${projectUrl(projectName)}/chat/upload`, { method: "POST", headers: authHeaders(), body: form });
    const json = await res.json();
    const first = json?.ok && Array.isArray(json.data) ? json.data[0] : null;
    if (!first || typeof first.path !== "string") return null;
    return { path: first.path, ...(typeof first.voiceReceipt === "string" ? { voiceReceipt: first.voiceReceipt } : {}) };
  } catch {
    return null;
  }
}

/** Deletes an upload the user dropped before sending. Best effort: an orphaned file is not worth a word. */
export async function discardChatUpload(projectName: string, serverPath: string): Promise<void> {
  const filename = serverPath.split(/[\\/]/).pop();
  if (!filename) return;
  try {
    await fetch(`${projectUrl(projectName)}/chat/uploads/${encodeURIComponent(filename)}`, { method: "DELETE", headers: authHeaders() });
  } catch {
    // Nothing depends on it.
  }
}
