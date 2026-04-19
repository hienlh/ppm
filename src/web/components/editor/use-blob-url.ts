import { useEffect, useState } from "react";
import { projectUrl, getAuthToken } from "@/lib/api-client";

/** Shared hook: fetch a project file as a blob URL via /files/raw endpoint. */
export function useBlobUrl(
  filePath: string,
  projectName: string,
  mimeOverride?: string,
) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoke: string | undefined;
    const url = `${projectUrl(projectName)}/files/raw?path=${encodeURIComponent(filePath)}`;
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.blob();
      })
      .then((blob) => {
        const final = mimeOverride ? new Blob([blob], { type: mimeOverride }) : blob;
        const u = URL.createObjectURL(final);
        revoke = u;
        setBlobUrl(u);
      })
      .catch(() => setError(true));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [filePath, projectName, mimeOverride]);

  return { blobUrl, error };
}
