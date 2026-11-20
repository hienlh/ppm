/**
 * A real 59-second Vietnamese dictation (from trying the feature) that talked about translating.
 * With thinking off, Haiku obeyed the speech and answered with an English translation; the rewrite
 * guard caught it (147 of 161 words dropped, 122 added), so the user got the raw transcript. The
 * prompt now says the output keeps the transcript's language whatever the speech asks.
 */
import { describe, expect, it } from "bun:test";
import { CLEANUP_SYSTEM_PROMPT, cleanupPrompt, cleanupTranscript } from "../../../../src/services/voice-message/voice-cleanup.ts";
import { looksRewritten, wordDiff } from "../../../../src/services/voice-message/voice-word-change.ts";

const RAW = "À, ok. Bây giờ anh giả bộ. Bây giờ anh mua thử nói nhiều, nói dài. Rồi để xem thử cái con AI nó translate này, nó tạo transcript này, xem thử nó có tạo đúng hay không. Rồi anh xem thử nó tạo có nhanh hay không. Ví dụ như giới hạn thời gian là 2 phút đi. Đang là 2 phút đây. Thì bây giờ anh thử nói khoảng tới 1 phút. Để xem thử detect cái speed của nó như thế nào. Nó tạo cái transcript có nhanh hay không. Nó tạo có đúng hay không. Thì ok thì anh sẽ bật cho nó chạy tự động luôn. Chứ không cần phải đọc lại transcript trước khi mà gửi nữa. Thì chắc là ok đó. Ví dụ như anh thử nói mấy từ tiếng âm như là AI, hay là Moodle, hay là Byron, invoice, time sheet. Thì xin dịch chung xem thử nó có dịch được không.";

/** What Haiku answered before the language rule (thinking off): the speech translated. */
const TRANSLATED = "Okay. Now I'll test it. I'll speak more and longer now. Then let me see how this AI translates it, how it creates the transcript, and check if it creates it correctly. Then I'll check how fast it creates it. For example, let's say the time limit is 2 minutes. Currently it's 2 minutes. So now I'll try speaking for about 1 minute. To see how it detects the speed. Whether it creates the transcript fast or not. Whether it creates it correctly or not. If it's okay, then I'll turn it on to run automatically. Without needing to read the transcript again before sending. Then I think it's okay. For example, let me try saying some technical terms like AI, Moodle, Byron, invoice, time sheet. So let me see if it can translate them correctly.";

/** What it answered with the rule, on the same transcript and context: the same words, tidied. */
const TIDIED = "À, ok. Bây giờ anh giả bộ. Bây giờ anh mua thử nói nhiều, nói dài. Rồi để xem thử cái con AI nó transcribe này, nó tạo transcript này, xem thử nó có tạo đúng hay không. Rồi anh xem thử nó tạo có nhanh hay không. Ví dụ như giới hạn thời gian là 2 phút đi. Đang là 2 phút đây. Thì bây giờ anh thử nói khoảng tới 1 phút. Để xem thử detect cái speed của nó như thế nào. Nó tạo cái transcript có nhanh hay không. Nó tạo có đúng hay không. Thì ok thì anh sẽ bật cho nó chạy tự động luôn. Chứ không cần phải đọc lại transcript trước khi mà gửi nữa. Thì chắc là ok đó. Ví dụ như anh thử nói mấy từ tiếng Anh như là AI, hay là Moodle, hay là Byron, invoice, time sheet. Thì xin dịch chung xem thử nó có dịch được không.";

const EMPTY_CONTEXT = { recentMessages: [], typed: "", instructions: "", memory: "", fileNames: [], words: [] };

describe("a long Vietnamese dictation that talks about translating", () => {
  it("a translation of it is caught as a rewrite", () => {
    const d = wordDiff(RAW.toLowerCase(), TRANSLATED.toLowerCase());
    expect(d.beforeWords).toBeGreaterThan(150);
    expect(d.added).toBeGreaterThan(d.beforeWords * 0.5);
    expect(looksRewritten(RAW, TRANSLATED)).toBe(true);
  });

  it("the tidied Vietnamese passes the guard, so the long message is not refused for its length", () => {
    expect(looksRewritten(RAW, TIDIED)).toBe(false);
  });

  it("a translated answer comes back as the raw transcript with the reason", async () => {
    const result = await cleanupTranscript(RAW, EMPTY_CONTEXT, async () => JSON.stringify({ text: TRANSLATED }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("changed too much");
  });

  it("the prompt keeps the transcript's language even when the speech asks for a translation", () => {
    expect(CLEANUP_SYSTEM_PROMPT).toContain("same language as the transcript");
    expect(CLEANUP_SYSTEM_PROMPT).toContain("even when the transcript talks about translating");
    expect(cleanupPrompt(RAW, EMPTY_CONTEXT)).toContain("in the transcript's own language");
  });
});
