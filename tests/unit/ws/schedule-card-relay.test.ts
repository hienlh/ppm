/**
 * A script schedule's card pressed away from PPM: Telegram and the Assistant's mirror can deny it,
 * never allow it — even if a surface drew an Allow button it should not have.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { collabApprovalBroker, setCollabApprovalChat } from "../../../src/services/session-collab/collab-approval-broker.ts";
import { settleCollabApprovalFromServer } from "../../../src/server/ws/chat-collab-approval-relay.ts";
import type { SessionCollabApprovalRequest, SessionCollabScheduleApproval } from "../../../src/shared/session-collab.ts";

const SESSION = "relay-schedule-chat";
const card = (reviewInPpm?: string): SessionCollabScheduleApproval => ({
  kind: "schedule", action: "create_script",
  summary: { headline: "Create the script schedule", facts: [], body: { label: "Script", text: "x", format: "code" }, ...(reviewInPpm ? { reviewInPpm } : {}) },
});

let shown: SessionCollabApprovalRequest[] = [];
setCollabApprovalChat({ announce: (_s, e) => { shown.push(e); return true; }, resolved: () => {} });
afterEach(() => {
  collabApprovalBroker.cancelSession(SESSION, "test over");
  shown = [];
});

describe("a schedule card pressed off PPM", () => {
  it("is never allowed from Telegram when it may be allowed only in PPM, but can be denied", async () => {
    const outcome = collabApprovalBroker.request(SESSION, card("Allow in PPM only."));
    const { requestId } = shown[0]!;
    expect(settleCollabApprovalFromServer(SESSION, requestId, true, "telegram")).toBe("stale");
    expect(settleCollabApprovalFromServer(SESSION, requestId, true, "assistant_card")).toBe("stale");
    expect(collabApprovalBroker.has(requestId)).toBe(true);
    expect(settleCollabApprovalFromServer(SESSION, requestId, false, "telegram")).toBe("answered");
    expect(await outcome).toMatchObject({ allowed: false, reason: "denied" });
  });

  it("is allowed from Telegram when it is an ordinary card (pausing a schedule)", async () => {
    const outcome = collabApprovalBroker.request(SESSION, card());
    expect(settleCollabApprovalFromServer(SESSION, shown[0]!.requestId, true, "telegram")).toBe("answered");
    expect(await outcome).toMatchObject({ allowed: true });
  });
});
