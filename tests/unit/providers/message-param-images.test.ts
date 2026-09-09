import { describe, test, expect } from "bun:test";
import { buildMessageParam } from "../../../src/providers/claude-agent-sdk.ts";

const img = (mediaType = "image/png") => ({ data: "aGVsbG8=", mediaType });

/**
 * The shape of the message pushed to the SDK decides whether an attachment reaches the model
 * as pixels or as a filename it has to go and open. The opening turn of a session is the most
 * common place to attach one — new tab, paste, send — and it once dropped the payload there
 * while every other path kept it.
 */
describe("buildMessageParam", () => {
  test("plain text stays a string", () => {
    expect(buildMessageParam("hello")).toEqual({ role: "user", content: "hello" });
  });

  test("no images is the same as text alone", () => {
    expect(buildMessageParam("hello", []).content).toBe("hello");
  });

  test("an image becomes a block alongside the text", () => {
    const out = buildMessageParam("what is this?", [img()]);
    const blocks = out.content as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(blocks[1]).toEqual({ type: "text", text: "what is this?" });
  });

  test("every image is carried, in order", () => {
    const blocks = buildMessageParam("x", [img("image/png"), img("image/jpeg")]).content as Array<Record<string, unknown>>;
    const types = blocks.filter((b) => b.type === "image").map((b) => (b.source as { media_type: string }).media_type);
    expect(types).toEqual(["image/png", "image/jpeg"]);
  });

  // An attachment with nothing typed alongside it is a real message, not an empty one.
  test("an image with no text carries the image and no empty text block", () => {
    const blocks = buildMessageParam("", [img()]).content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("image");
  });

  test("whitespace-only text is not sent as a block either", () => {
    const blocks = buildMessageParam("   ", [img()]).content as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "text")).toBe(false);
  });
});
