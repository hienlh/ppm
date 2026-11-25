/**
 * The card a plan waits on (Claude's ExitPlanMode in plan mode): the plan line by line, each line
 * open to a comment, and either Approve or Send feedback — the comments, quoted beside their lines,
 * go back to Claude as what to do instead, and it keeps planning. Preview shows the plan rendered.
 */
import { useMemo, useState } from "react";
import { Check, ClipboardList, Eye, MessageCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatPlanComments, type PlanComments } from "@/lib/line-comments";
import { LineCommentBox } from "@/components/shared/line-comment-box";
import { MarkdownContent } from "./message-markdown";

const BTN = "min-h-11 md:min-h-0 px-3 py-1.5 rounded text-xs font-medium transition-colors";

/** The plan an ExitPlanMode call carries, or null when the input is not that shape. */
export function planOf(tool: string, input: unknown): string | null {
  if (tool !== "ExitPlanMode" || !input || typeof input !== "object") return null;
  const plan = (input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

export function PlanApprovalCard({ requestId, plan, projectName, onRespond }: {
  requestId: string;
  plan: string;
  projectName?: string;
  onRespond: (requestId: string, approved: boolean, choice?: { message?: string }) => void;
}) {
  const lines = useMemo(() => plan.replace(/\r\n/g, "\n").split("\n"), [plan]);
  const [comments, setComments] = useState<PlanComments>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [overall, setOverall] = useState("");
  const [preview, setPreview] = useState(false);
  const count = Object.values(comments).filter((c) => c.trim()).length;
  const feedback = formatPlanComments(lines, comments, overall);

  const setComment = (i: number, body: string) => setComments((prev) => {
    const next = { ...prev };
    if (body.trim()) next[i] = body.trim();
    else delete next[i];
    return next;
  });

  return (
    <div className="space-y-2 rounded-lg border-2 border-primary/40 bg-accent-wash p-3" data-approval-request={requestId} data-plan-approval="">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <ClipboardList className="size-4" />
        <span className="flex-1">Plan ready for review</span>
        <button
          type="button"
          onClick={() => setPreview(!preview)}
          aria-pressed={preview}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text max-md:h-[26px]"
        >
          {preview ? <MessageCircle className="size-3.5" /> : <Eye className="size-3.5" />}
          {preview ? "Comment" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div className="max-h-[28rem] overflow-y-auto rounded border border-border bg-background p-3 text-sm">
          <MarkdownContent content={plan} projectName={projectName} />
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto rounded border border-border bg-background py-1 text-[13px]" data-plan-lines="">
          {lines.map((line, i) => {
            const open = editing === i || comments[i] !== undefined;
            return (
              <div key={i}>
                <div className={cn("group/line grid grid-cols-[36px_minmax(0,1fr)]", comments[i] !== undefined && "bg-primary/5")}>
                  <button
                    type="button"
                    onClick={() => setEditing(i)}
                    aria-label={"Comment on line " + (i + 1)}
                    title="Comment on this line"
                    data-plan-line={i}
                    className="relative cursor-pointer select-none pr-2 text-right text-[11px] leading-5 text-text-3 hover:bg-primary/10 hover:text-primary"
                  >
                    <span className="group-hover/line:invisible">{i + 1}</span>
                    <MessageCircle className="absolute inset-y-0 right-2 my-auto hidden size-3 group-hover/line:block" aria-hidden="true" />
                  </button>
                  <span className={cn("min-w-0 whitespace-pre-wrap break-words pr-3 leading-5 text-text", /^#{1,6}\s/.test(line) && "font-semibold")}>
                    {line || " "}
                  </span>
                </div>
                {open && (
                  <LineCommentBox
                    body={comments[i] ?? ""}
                    editing={editing === i}
                    onEdit={() => setEditing(i)}
                    onSave={(body) => { setComment(i, body); setEditing(null); }}
                    onCancel={() => setEditing(null)}
                    onDelete={() => { setComment(i, ""); setEditing(null); }}
                    className="my-1 mr-3 ml-9"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <textarea
        value={overall}
        onChange={(e) => setOverall(e.target.value)}
        rows={2}
        placeholder="Anything else Claude should change (optional)"
        aria-label="Feedback on the plan"
        className="w-full resize-y rounded border border-border bg-background p-2 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onRespond(requestId, true)}
          className={cn(BTN, "inline-flex items-center gap-1 px-4 bg-success text-white hover:bg-success/80")}
        >
          <Check className="size-3.5" />Approve plan
        </button>
        <button
          type="button"
          onClick={() => onRespond(requestId, false, feedback ? { message: feedback } : undefined)}
          data-plan-feedback=""
          className={cn(BTN, "border border-border text-text hover:bg-surface-hover")}
        >
          {feedback ? "Send feedback" + (count ? " (" + count + (count === 1 ? " comment" : " comments") + ")" : "") : "Keep planning"}
        </button>
        {count > 0 && <span className="text-[11px] text-text-3">Approving ignores the comments.</span>}
      </div>
    </div>
  );
}
