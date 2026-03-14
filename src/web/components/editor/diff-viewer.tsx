import { useEffect, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { api } from "../../lib/api-client";
import { Loader2 } from "lucide-react";

interface DiffViewerProps {
  leftPath: string;
  rightPath: string;
}

export function DiffViewer({ leftPath, rightPath }: DiffViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contents, setContents] = useState<{ left: string; right: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<{ content: string }>(`/api/files/read?path=${encodeURIComponent(leftPath)}`),
      api.get<{ content: string }>(`/api/files/read?path=${encodeURIComponent(rightPath)}`),
    ])
      .then(([l, r]) => setContents({ left: l.content, right: r.content }))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [leftPath, rightPath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm px-4 text-center">
        {error}
      </div>
    );
  }

  if (!contents) return null;

  return <DiffViewerInner left={contents.left} right={contents.right} />;
}

function DiffViewerInner({ left, right }: { left: string; right: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const view = new MergeView({
      a: {
        doc: left,
        extensions: [oneDark, EditorState.readOnly.of(true)],
      },
      b: {
        doc: right,
        extensions: [oneDark, EditorState.readOnly.of(true)],
      },
      parent: el,
    });

    return () => {
      view.destroy();
    };
  }, [left, right]);

  return <div ref={containerRef} className="h-full overflow-auto text-sm" />;
}
