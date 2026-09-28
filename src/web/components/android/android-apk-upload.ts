/**
 * Uploading an APK with progress and a working cancel.
 *
 * `fetch` has no upload progress — `ReadableStream` request bodies do exist but need HTTP/2 and
 * a `duplex` option that PPM's usual plain-HTTP LAN deployment cannot rely on, and even then
 * nothing reports how far the send has got. `XMLHttpRequest.upload.onprogress` does, and
 * `xhr.abort()` really stops the send rather than only dropping the response. So this is the one
 * place in the Android client that is not on the api client.
 *
 * It is kept out of the component so the URL it builds and the way it reads an error can be
 * unit-tested; a component here cannot be imported under `bun:test` (the stores read
 * `localStorage` at module scope).
 */

export interface ApkUploadOptions {
  deviceId: string;
  file: File;
  allowDowngrade?: boolean;
  token: string | null;
  onProgress?: (fraction: number) => void;
}

export interface ApkUploadHandle {
  /** Resolves with the operation id the server started for the install itself. */
  done: Promise<string>;
  cancel(): void;
}

export function apkUploadUrl(deviceId: string, filename: string, allowDowngrade: boolean): string {
  const params = new URLSearchParams({ filename });
  if (allowDowngrade) params.set("downgrade", "1");
  return `/api/android/devices/${encodeURIComponent(deviceId)}/apk?${params.toString()}`;
}

/** PPM's envelope is `{ok, data}` / `{ok:false, error}`; a proxy's 502 page is neither. */
export function readUploadResponse(status: number, body: string): { operationId: string } {
  let parsed: unknown = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON at all */ }
  const envelope = parsed as { ok?: boolean; error?: string; data?: { operationId?: string } } | null;
  if (status >= 200 && status < 300 && envelope?.ok && envelope.data?.operationId) {
    return { operationId: envelope.data.operationId };
  }
  throw new Error(envelope?.error ?? (body.trim() || `the upload failed with HTTP ${status}`));
}

export function uploadApk(opts: ApkUploadOptions): ApkUploadHandle {
  const xhr = new XMLHttpRequest();
  let cancelled = false;

  const done = new Promise<string>((resolve, reject) => {
    xhr.open("POST", apkUploadUrl(opts.deviceId, opts.file.name, opts.allowDowngrade === true));
    if (opts.token) xhr.setRequestHeader("Authorization", `Bearer ${opts.token}`);
    xhr.setRequestHeader("Content-Type", "application/vnd.android.package-archive");
    xhr.setRequestHeader("x-ppm-client", "web");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try { resolve(readUploadResponse(xhr.status, xhr.responseText).operationId); } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error("the upload could not reach the server"));
    xhr.onabort = () => reject(new Error("cancelled"));
    xhr.send(opts.file);
  });

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      xhr.abort();
    },
  };
}
