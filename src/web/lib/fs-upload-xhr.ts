/**
 * Single-file upload over `XMLHttpRequest`. `fetch` gives no upload progress events, so the
 * queue needs XHR for the per-file percentage the toast shows; everything else about the
 * request (auth header, error shape) mirrors `fs-api.ts`'s `request()`.
 */

import { getAuthToken } from "./api-client";
import { fsApi, FsError } from "./fs-api";

export interface UploadProgress {
  loaded: number;
  total: number;
}

interface UploadResponseBody {
  ok?: boolean;
  data?: { path: string; size: number };
  error?: string;
  code?: string;
}

/**
 * Resolves with the uploaded `{ path, size }`. Rejects with `FsError` for a server refusal
 * (409 `EEXIST`, 403 `EDENIED`, …) and a plain `Error` for a network failure — the caller
 * tells them apart with `instanceof FsError`, same as every other `fs-api` call.
 */
export function uploadFileXhr(
  path: string,
  file: File,
  overwrite: boolean,
  onProgress: (progress: UploadProgress) => void,
): Promise<{ path: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", fsApi.uploadUrl(path, overwrite));
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("x-ppm-client", "web");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    };

    xhr.onload = () => {
      let json: UploadResponseBody = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Falls through to the status-based rejection below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && json.ok !== false && json.data) {
        resolve(json.data);
        return;
      }
      reject(new FsError(json.error ?? `HTTP ${xhr.status}`, json.code ?? "EUNKNOWN", xhr.status));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

    xhr.send(file);
  });
}
