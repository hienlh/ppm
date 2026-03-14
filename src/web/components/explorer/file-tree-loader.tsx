import { useEffect, useState } from "react";
import { api } from "../../lib/api-client";
import type { FileEntry } from "../../../types/api";
import { FileTree } from "./file-tree";
import { Loader2 } from "lucide-react";

interface FileTreeLoaderProps {
  projectName: string;
  projectPath: string;
}

export function FileTreeLoader({ projectName, projectPath }: FileTreeLoaderProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .get<FileEntry[]>(`/api/files/tree/${encodeURIComponent(projectName)}?depth=3`)
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-16">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">{error}</div>
    );
  }

  return (
    <FileTree
      entries={entries}
      projectName={projectName}
      onRefresh={load}
    />
  );
}
