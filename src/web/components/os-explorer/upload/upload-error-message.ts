/**
 * Turns an upload failure into a short, human row message for the progress panel. A fresh
 * 409/EEXIST never reaches here — `uploadResolvingCollisions` already resolves that through
 * the collision prompt before the job can fail.
 */

import { FsError } from "@/lib/fs-api";

export function describeUploadError(error: unknown): string {
  if (error instanceof FsError) {
    if (error.status === 403) return "Not allowed here";
    // Cloudflare's free-tier request-body cap when the app is reached through a tunnel — a
    // client-observed HTTP status, not a code PPM's own upload route ever emits itself.
    if (error.status === 413) return "File too large for the tunnel (100 MB)";
    return error.message || "Upload failed";
  }
  if (error instanceof Error) return "Connection lost";
  return "Upload failed";
}
