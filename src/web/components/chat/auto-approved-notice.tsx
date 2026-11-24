/**
 * The one line a chat shows where a remembered rule approved a request in place of a card, so the
 * user always sees what ran without asking them, and can remove the rule from there.
 */
import { ShieldCheck } from "@/lib/icons";
import { openSettings } from "@/components/settings/open-settings";
import type { AutoApprovedEvent } from "../../../shared/remembered-approvals";

export function AutoApprovedNotice({ event }: { event: AutoApprovedEvent }) {
  return (
    <div role="status" data-testid="auto-approved-notice" data-rule-id={event.ruleId}
      className="flex items-start gap-2 py-0.5 text-[13px] text-text-secondary">
      <ShieldCheck className="mt-[3px] size-3.5 shrink-0 text-success" />
      <p className="min-w-0 flex-1 break-words leading-normal">
        Approved by your rule: <b className="font-medium text-text-primary">{event.label}</b>.{" "}
        <button
          type="button"
          onClick={() => openSettings("approvals")}
          className="whitespace-nowrap font-medium text-primary"
        >
          Review rules
        </button>
      </p>
    </div>
  );
}
