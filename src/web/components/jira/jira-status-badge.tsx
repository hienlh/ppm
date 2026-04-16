import { Badge } from "@/components/ui/badge";
import type { JiraResultStatus } from "../../../../src/types/jira";

const STATUS_STYLES: Record<JiraResultStatus, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 border-yellow-500/30",
  running: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  done: "bg-green-500/15 text-green-600 border-green-500/30",
  failed: "bg-red-500/15 text-red-600 border-red-500/30",
};

export function JiraStatusBadge({ status }: { status: JiraResultStatus }) {
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_STYLES[status] ?? ""}`}>
      {status}
    </Badge>
  );
}
