import { useEffect, useRef, useState } from "react";
import { projectUrl, getAuthToken } from "@/lib/api-client";

/** Shared hook: fetch a project file as a blob URL via /files/raw endpoint.
 *  Detects absolute paths (external files) and uses /api/fs/raw instead.
 *  Pass a changing `refreshKey` to re-fetch without unmounting. */
export function useBlobUrl(
  filePath: string,
  projectName: string,
  mimeOverride?: string,
  refreshKey = 0,
) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
    const url = isExternal
      ? `/api/fs/raw?path=${encodeURIComponent(filePath)}`
      : `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const final = mimeOverride ? new Blob([blob], { type: mimeOverride }) : blob;
        const u = URL.createObjectURL(final);
        // Revoke old URL only after new one is ready (avoids blank flash)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = u;
        setBlobUrl(u);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [filePath, projectName, mimeOverride, refreshKey]);

  // Revoke on unmount
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return { blobUrl, error };
}
