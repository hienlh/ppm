import { Badge } from "@/components/ui/badge";
import type { JiraResultStatus } from "../../../../src/types/jira";

const STATUS_STYLES: Record<JiraResultStatus, string> = {
  pending: "bg-warning/15 text-warning border-warning/30",
  queued: "bg-warning/10 text-warning/80 border-warning/20",
  running: "bg-primary/15 text-primary border-primary/30",
  done: "bg-success/15 text-success border-success/30",
  failed: "bg-error/15 text-error border-error/30",
};

export function JiraStatusBadge({ status }: { status: JiraResultStatus }) {
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_STYLES[status] ?? ""}`}>
      {status}
    </Badge>
  );
}
