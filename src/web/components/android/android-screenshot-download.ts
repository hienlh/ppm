/**
 * Saving a screenshot to the browser's downloads.
 *
 * The route needs the `Authorization` header, so a plain `<a href>` cannot fetch it — the bytes
 * come back through `fetch` and are handed to an anchor as a blob URL. Kept out of the component
 * so the two easy things to get wrong are testable: reading the server's filename out of
 * `Content-Disposition`, and revoking the URL (a blob URL revoked too early gives the browser a
 * broken download with no error, CLAUDE.md).
 */

/** The server names the file; this only has to survive a header it did not write. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  // RFC 5987 `filename*=UTF-8''...` wins over the plain form when both are present.
  const extended = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (extended?.[1]) {
    try { return decodeURIComponent(extended[1].trim()) || fallback; } catch { /* malformed */ }
  }
  const quoted = header.match(/filename\s*=\s*"([^"]*)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
  const name = quoted?.[1]?.trim();
  return name && name.length > 0 ? name : fallback;
}

export function screenshotUrl(deviceId: string): string {
  return `/api/android/devices/${encodeURIComponent(deviceId)}/screenshot`;
}

/** Hand a blob to the browser as a download. Exported so the save can be tested without a fetch. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously races the download in Safari and Firefox; a tick is enough and the
  // page holds nothing else on it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadScreenshot(deviceId: string, token: string | null, fallbackName: string): Promise<void> {
  const res = await fetch(screenshotUrl(deviceId), {
    headers: token ? { Authorization: `Bearer ${token}`, "x-ppm-client": "web" } : { "x-ppm-client": "web" },
  });
  if (!res.ok) {
    // The route answers PPM's envelope on failure and raw PNG on success.
    let message = `the screenshot failed with HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) message = body.error;
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  saveBlob(await res.blob(), filenameFromDisposition(res.headers.get("content-disposition"), fallbackName));
}
