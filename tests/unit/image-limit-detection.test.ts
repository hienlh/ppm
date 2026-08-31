import { describe, expect, test } from "bun:test";
import { isImageLimitRejection } from "../../src/providers/image-limit-detection.ts";

/** An assistant record shaped the way the CLI writes it. */
function assistantMsg(text: string, isApiErrorMessage: boolean) {
  return {
    type: "assistant",
    isApiErrorMessage,
    message: { role: "assistant", model: isApiErrorMessage ? "<synthetic>" : "claude-opus-5", content: [{ type: "text", text }] },
  };
}

// Both wordings observed in real transcripts.
const HARD = "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.";
const SOFT = "API Error: an image in the conversation could not be processed and was removed. Re-read the file with a different approach if you still need it.";

describe("isImageLimitRejection", () => {
  test("recognises both API refusal wordings", () => {
    expect(isImageLimitRejection(assistantMsg(HARD, true))).toBe(true);
    expect(isImageLimitRejection(assistantMsg(SOFT, true))).toBe(true);
  });

  // A hit rewrites the transcript and deletes image payloads, so ordinary prose using the same
  // words must never qualify — these all matched before the isApiErrorMessage gate was added.
  test.each([
    "The hero image container is too large on mobile — drop it to 60vh.",
    "That image was too large to inline, so I saved it to disk instead.",
    "Anthropic applies a stricter per-image dimension limit above 20 images per request.",
    "Try the carousel with fewer images so the layout does not wrap.",
    "Your avatar image could not be processed by the uploader — the MIME type is wrong.",
    "Consider using fewer images in the README to keep the repo small.",
  ])("ignores ordinary assistant prose: %s", (text) => {
    expect(isImageLimitRejection(assistantMsg(text, false))).toBe(false);
  });

  test("ignores the refusal wording itself when it is not an error record", () => {
    expect(isImageLimitRejection(assistantMsg(HARD, false))).toBe(false);
    expect(isImageLimitRejection(assistantMsg(SOFT, false))).toBe(false);
  });

  test("ignores an error record that is not about images", () => {
    expect(isImageLimitRejection(assistantMsg("API Error: 401 OAuth access token has been revoked.", true))).toBe(false);
    expect(isImageLimitRejection(assistantMsg("API Error: 529 Overloaded", true))).toBe(false);
  });

  test("tolerates malformed messages", () => {
    expect(isImageLimitRejection(null)).toBe(false);
    expect(isImageLimitRejection({})).toBe(false);
    expect(isImageLimitRejection({ isApiErrorMessage: true })).toBe(false);
    expect(isImageLimitRejection({ isApiErrorMessage: true, message: { content: "not an array" } })).toBe(false);
    expect(isImageLimitRejection({ isApiErrorMessage: true, message: { content: [] } })).toBe(false);
  });
});
