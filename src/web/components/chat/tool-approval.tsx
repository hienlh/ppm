import { Button } from "../ui/button";

interface ToolApprovalProps {
  tool: string;
  input: unknown;
  onApprove: () => void;
  onDeny: () => void;
}

export function ToolApproval({ tool, input, onApprove, onDeny }: ToolApprovalProps) {
  return (
    <div className="border border-yellow-500/40 bg-yellow-500/10 rounded-lg p-3 mx-2 mb-2">
      <div className="text-xs font-semibold text-yellow-400 mb-1">Tool Approval Required</div>
      <div className="text-sm font-mono text-foreground mb-1">{tool}</div>
      <pre className="text-xs text-muted-foreground overflow-auto max-h-24 bg-muted/40 rounded p-2 mb-3">
        {JSON.stringify(input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button
          size="lg"
          className="flex-1 h-11 text-base"
          onClick={onApprove}
        >
          Allow
        </Button>
        <Button
          size="lg"
          variant="destructive"
          className="flex-1 h-11 text-base"
          onClick={onDeny}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
