/**
 * A file the Import/Export tab reads from: sent as the request's body (`PUT /api/db/impexp/uploads`),
 * which the server writes to disk as it arrives. Over `XMLHttpRequest`, because `fetch` reports no
 * upload progress and a 100 MB file takes long enough to need it.
 */
import { api, getAuthToken } from "@/lib/api-client";
import type { ImportUpload } from "../../../../shared/db-impexp";

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Resolves with the upload's id on the server; rejects with the server's own sentence when it refused. */
export function uploadImpExpFile(file: File, onProgress: (p: UploadProgress) => void, signal: AbortSignal): Promise<ImportUpload> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/db/impexp/uploads?name=${encodeURIComponent(file.name)}`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("x-ppm-client", "web");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    };
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort);
    const detach = () => signal.removeEventListener("abort", abort);
    xhr.onload = () => {
      detach();
      let body: { ok?: boolean; data?: ImportUpload; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Said by the status below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok !== false && body.data) resolve(body.data);
      else reject(new Error(body.error ?? `The server answered HTTP ${xhr.status}`));
    };
    xhr.onerror = () => { detach(); reject(new Error("The connection to PPM was lost during the upload")); };
    xhr.onabort = () => { detach(); reject(new DOMException("Upload aborted", "AbortError")); };
    xhr.send(file);
  });
}

/** Lets the server remove an upload no row reads any more; one already gone is the same answer. */
export function deleteImpExpUpload(id: string): void {
  api.del(`/api/db/impexp/uploads/${encodeURIComponent(id)}`).catch(() => { /* swept up within the hour */ });
}
