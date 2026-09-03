import { describe, expect, test } from "bun:test";
import {
  normalizeSendMessage,
  parseSendMessageResult,
} from "../../../src/web/components/chat/send-message-parse";

describe("normalizeSendMessage", () => {
  test("keeps the canonical fields and drops the legacy duplicates", () => {
    const msg = normalizeSendMessage({
      to: "dev-p1",
      summary: "Shield ~/.ppm from copy/move source",
      message: "Lead: yes — close the gap you flagged.\nAdd one test per op.",
      type: "message",
      recipient: "dev-p1",
      content: "Lead: yes — close the gap you flagged. On explore…",
    });

    expect(msg.to).toBe("dev-p1");
    expect(msg.summary).toBe("Shield ~/.ppm from copy/move source");
    expect(msg.text).toBe("Lead: yes — close the gap you flagged.\nAdd one test per op.");
    expect(msg.firstLine).toBe("Lead: yes — close the gap you flagged.");
    expect(msg.kind).toBe("message");
    expect(msg.notifyWhenIdle).toBe(false);
    expect(msg.extras).toEqual([]);
    expect(msg.protocol).toBeUndefined();
  });

  test("falls back to the legacy aliases when the canonical fields are absent", () => {
    const msg = normalizeSendMessage({ recipient: "researcher", content: "start on task #1" });
    expect(msg.to).toBe("researcher");
    expect(msg.text).toBe("start on task #1");
  });

  test("reads a protocol object body instead of rendering it as prose", () => {
    const msg = normalizeSendMessage({
      to: "team-lead",
      message: { type: "shutdown_response", request_id: "req-7", approve: true },
    });
    expect(msg.kind).toBe("shutdown_response");
    expect(msg.protocol).toEqual({
      type: "shutdown_response",
      request_id: "req-7",
      approve: true,
      reason: undefined,
      feedback: undefined,
    });
    expect(msg.text).toBe("");
  });

  test("reads the same protocol body when it arrives as a JSON string", () => {
    const msg = normalizeSendMessage({
      to: "researcher",
      message: '{"type":"plan_approval_response","request_id":"p2","approve":false,"feedback":"add error handling"}',
    });
    expect(msg.kind).toBe("plan_approval_response");
    expect(msg.protocol?.approve).toBe(false);
    expect(msg.protocol?.feedback).toBe("add error handling");
  });

  test("prose that merely starts with a brace stays prose", () => {
    const msg = normalizeSendMessage({ to: "dev", message: "{ not json after all" });
    expect(msg.protocol).toBeUndefined();
    expect(msg.text).toBe("{ not json after all");
  });

  test("surfaces notify_when_idle and unknown keys instead of swallowing them", () => {
    const msg = normalizeSendMessage({
      to: "worker",
      message: "check if tests pass over there",
      notify_when_idle: true,
      future_field: "keep me",
    });
    expect(msg.notifyWhenIdle).toBe(true);
    expect(msg.extras).toEqual([{ key: "future_field", value: "keep me" }]);
  });

  test("legacy type other than message becomes the badge kind", () => {
    const msg = normalizeSendMessage({ recipient: "lead", content: "done", type: "completion" });
    expect(msg.kind).toBe("completion");
  });

  test("tolerates a missing recipient and body", () => {
    const msg = normalizeSendMessage({});
    expect(msg.to).toBe("");
    expect(msg.text).toBe("");
    expect(msg.firstLine).toBe("");
    expect(msg.kind).toBe("message");
  });
});

describe("parseSendMessageResult", () => {
  test("unwraps the JSON-inside-JSON success payload", () => {
    const output = JSON.stringify([
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          message: "Resuming agent dev-p1",
          resumedAgentId: "a8531e43894c304c9",
          pin: { id: "a8531e43894c304c9", name: "dev-p1", ref: "bbbba0" },
        }),
      },
    ]);

    expect(parseSendMessageResult(output)).toEqual({
      ok: true,
      detail: "Resuming agent dev-p1",
      peer: "dev-p1",
      ref: "bbbba0",
    });
  });

  test("reports a failure and its error text", () => {
    const output = JSON.stringify([
      { type: "text", text: JSON.stringify({ success: false, error: "No agent named dev-p9" }) },
    ]);
    expect(parseSendMessageResult(output)).toEqual({
      ok: false,
      detail: "No agent named dev-p9",
      peer: undefined,
      ref: undefined,
    });
  });

  test("accepts an already-unwrapped status object", () => {
    const output = JSON.stringify({ success: true, message: "Delivered" });
    expect(parseSendMessageResult(output)?.ok).toBe(true);
  });

  test("returns null for shapes the card cannot summarise, so raw output still shows", () => {
    expect(parseSendMessageResult("")).toBeNull();
    expect(parseSendMessageResult("Message sent.")).toBeNull();
    expect(parseSendMessageResult(JSON.stringify([{ type: "text", text: "plain ack" }]))).toBeNull();
    expect(parseSendMessageResult(JSON.stringify({ queued: true }))).toBeNull();
  });
});
