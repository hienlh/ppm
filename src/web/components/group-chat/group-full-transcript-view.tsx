import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getTranscript, type TranscriptResult } from "@/lib/api-group-chat";
import { GroupTranscriptMessages } from "./group-transcript-messages";
import type { GroupMessage } from "../../../types/group-chat";

interface GroupFullTranscriptViewProps {
  groupId: string;
  message: GroupMessage | null;
  onClose: () => void;
}

/** Read-only transcript view for a single member turn.
 *  Adaptive: centered dialog on desktop, bottom sheet on mobile. */
export function GroupFullTranscriptView({ groupId, message, onClose }: GroupFullTranscriptViewProps) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<TranscriptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = message?.fullSessionRef ?? null;

  useEffect(() => {
    if (!message || !sessionRef) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    getTranscript(groupId, sessionRef)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load transcript"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, sessionRef, message]);

  if (!message) return null;

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      )}
      {error && (
        <div className="px-1 py-4 text-sm text-text-secondary">
          <p className="mb-2 font-medium text-foreground">Full transcript unavailable</p>
          <p className="text-xs text-text-subtle">{error}</p>
          {message.summary && (
            <pre className="mt-4 whitespace-pre-wrap break-words rounded-md bg-surface-elevated p-3 text-xs leading-relaxed text-text-secondary">
              {message.summary}
            </pre>
          )}
        </div>
      )}
      {!loading && !error && data != null && (
        <div className="px-1 py-1">
          <GroupTranscriptMessages messages={data.messages} config={data.config} />
        </div>
      )}
    </div>
  );

  const title = `${message.fromMember} — full transcript`;

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="max-h-[85vh] flex flex-col">
        <div className="flex flex-col min-h-0 px-4 pb-2">
          <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
