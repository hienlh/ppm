/**
 * A spoken reply to a card from PPM's screen: what the reply carries, when the mic may start, what
 * the set of decisions sends and says for a spoken answer, and the receipt the upload route hands
 * out for a recording (the server's half of the same decision).
 */
import { describe, expect, it } from "bun:test";
import { cardMicState, cardVoiceReply, routeVoice, CARD_MIC_DRAFT_REASON, CARD_MIC_TYPED_REASON } from "../../../src/web/lib/card-voice-reply";
import { answerLabel, answerIsReady, sendPlan, cardVersion, type DecisionAnswer } from "../../../src/web/lib/decision-set/decision-set-model";
import { sendDecision, type DecisionSendApi } from "../../../src/web/lib/decision-set/decision-set-send";
import { decideVoiceSend, shouldAutoSend, voiceGate } from "../../../src/web/lib/voice-message-compose";
import { mintVoiceUploadReceipt, verifyVoiceUploadReceipt, VOICE_RECEIPT_TTL_MS } from "../../../src/services/voice-message/voice-upload-receipt";
import type { AssistantCard } from "../../../src/shared/assistant-cards";

const PATH = "C:/Users/x/.ppm/uploads/1a2b3c4d-voice-20261125T150000.webm";
const held = { path: PATH, durationSec: 4.2, receipt: "r", shown: "Ship option two.", raw: "ship option to" };

const card = (over: Partial<AssistantCard> = {}): AssistantCard => ({
  id: "c1", kind: "needs_decision", projectName: "ppm", projectKey: "k", sessionId: "mgr", title: "Pick", body: "",
  payload: {}, status: "open", wake: "none", createdAt: Date.now(), updatedAt: Date.now(), answer: null, okOffered: true, ...over,
} as AssistantCard);

describe("the reply a recording makes", () => {
  it("is the transcript with the recording and its receipt", () => {
    expect(cardVoiceReply({ path: PATH, durationSec: 3, transcript: "Go ahead." }, "rcpt"))
      .toEqual({ text: "Go ahead.", voice: { path: PATH, durationSec: 3, receipt: "rcpt" } });
  });

  it("is nothing without a receipt (the server would refuse it) or with an emptied transcript", () => {
    expect(cardVoiceReply({ path: PATH, durationSec: 3, transcript: "Go." }, undefined)).toBeNull();
    expect(cardVoiceReply({ path: PATH, durationSec: 3, transcript: "  " }, "rcpt")).toBeNull();
  });

  it("sends the route only what it takes from a held voice", () => {
    expect(routeVoice(held)).toEqual({ path: PATH, durationSec: 4.2, receipt: "r" });
  });
});

describe("the mic beside a card's field", () => {
  const base = { enabled: true, typed: "", hasDraft: false, recording: false };
  it("is hidden while voice messages are off or the browser cannot record", () => {
    expect(cardMicState({ ...base, enabled: false })).toEqual({ kind: "hidden" });
  });
  it("starts on an empty field", () => {
    expect(cardMicState(base).kind).toBe("ready");
  });
  it("is a reply typed or spoken, never both: typed words or pictures hold it, so do a second recording", () => {
    expect(cardMicState({ ...base, typed: "hi" })).toEqual({ kind: "blocked", label: CARD_MIC_TYPED_REASON });
    expect(cardMicState({ ...base, hasImages: true })).toEqual({ kind: "blocked", label: CARD_MIC_TYPED_REASON });
    expect(cardMicState({ ...base, hasDraft: true })).toEqual({ kind: "blocked", label: CARD_MIC_DRAFT_REASON });
  });
  it("stops the recording in progress", () => {
    expect(cardMicState({ ...base, recording: true }).kind).toBe("recording");
  });
});

describe("sending a spoken card reply follows the composer's rules", () => {
  it("waits for review with the setting on, goes by itself with it off once tidied", () => {
    const gate = voiceGate({ transcript: "ready", upload: "done", cleaned: true });
    expect(shouldAutoSend(gate, { reviewBeforeSend: true, cleaned: true })).toBe(false);
    expect(shouldAutoSend(gate, { reviewBeforeSend: false, cleaned: true })).toBe(true);
    // A raw transcript (the tidy-up failed) always waits to be read.
    expect(shouldAutoSend(gate, { reviewBeforeSend: false, cleaned: false })).toBe(false);
  });
  it("queues a press while transcribing and never sends a failed recording", () => {
    expect(decideVoiceSend(voiceGate({ transcript: "processing", upload: "uploading", cleaned: false }), { reviewBeforeSend: true, cleaned: false })).toBe("queue");
    expect(decideVoiceSend(voiceGate({ transcript: "ready", upload: "error", cleaned: true }), { reviewBeforeSend: false, cleaned: true })).toBe("refuse");
  });
});

describe("a spoken answer in the set of decisions", () => {
  const answer: DecisionAnswer = { kind: "reply", text: "Ship option two.", images: [], voice: held };

  it("is ready like typed words and is named as a voice reply in the review", () => {
    const c = card();
    expect(answerIsReady(c, answer)).toBe(true);
    expect(answerLabel(c, answer)).toBe("Voice reply: “Ship option two.”");
    expect(sendPlan([c], { c1: { answer, version: cardVersion(c) } })).toEqual([{ card: c, answer }]);
  });

  it("goes through the reply route with its recording", async () => {
    const calls: unknown[][] = [];
    const api: DecisionSendApi = {
      ok: async () => ({ card: card() }),
      choose: async () => ({ card: card() }),
      reply: async (...args) => { calls.push(args); return { card: card({ status: "answered" }) }; },
      refusal: () => ({ error: "x" }),
    };
    const outcome = await sendDecision(card(), answer, api);
    expect(outcome.status).toBe("sent");
    expect(calls[0]).toEqual(["c1", "Ship option two.", false, [], held]);
  });
});

describe("the upload route's receipt", () => {
  it("proves one recording, for six hours, in this run of PPM", () => {
    const now = 1_800_000_000_000;
    const receipt = mintVoiceUploadReceipt(PATH, now);
    expect(verifyVoiceUploadReceipt(PATH, receipt, now + 1000)).toBe(true);
    expect(verifyVoiceUploadReceipt(PATH.replace("voice-", "voice2-"), receipt, now)).toBe(false);
    expect(verifyVoiceUploadReceipt(PATH, receipt, now + VOICE_RECEIPT_TTL_MS + 1)).toBe(false);
    expect(verifyVoiceUploadReceipt(PATH, mintVoiceUploadReceipt(PATH, now + 10 * 60_000), now)).toBe(false);
    expect(verifyVoiceUploadReceipt(PATH, undefined, now)).toBe(false);
    expect(verifyVoiceUploadReceipt(PATH, "garbage", now)).toBe(false);
  });
});
