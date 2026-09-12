/**
 * The OpenAI wire format shared by both proxy bridges. The Claude bridge has no
 * coverage of its own, so these lock the flattening and response shapes it
 * depends on.
 */
import { describe, it, expect } from "bun:test";
import {
  buildPromptFromOpenAiMessages, hasUnsupportedBlocks, extractImagePayloads,
  completionResponse, openAiError,
} from "../../../src/services/proxy-openai-format.ts";

describe("proxy openai format", () => {
  it("splits system messages out and labels the conversation turns", () => {
    const r = buildPromptFromOpenAiMessages({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
    });
    expect(r.systemPrompt).toBe("be terse");
    expect(r.prompt).toBe("Human: hi\n\nAssistant: hello\n\nHuman: bye");
  });

  it("joins multiple system messages rather than keeping only the last", () => {
    const r = buildPromptFromOpenAiMessages({
      messages: [
        { role: "system", content: "rule one" },
        { role: "system", content: "rule two" },
        { role: "user", content: "go" },
      ],
    });
    expect(r.systemPrompt).toBe("rule one\nrule two");
  });

  it("reads text out of block-array content", () => {
    const r = buildPromptFromOpenAiMessages({
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
    });
    expect(r.prompt).toBe("Human: a\nb");
  });

  it("keeps only the text in the prompt and hands images back separately", () => {
    const withImage = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    };
    // The prompt carries text; the picture travels as a file, not as prompt text.
    expect(buildPromptFromOpenAiMessages(withImage).prompt).toBe("Human: what is this?");
    expect(hasUnsupportedBlocks(withImage)).toBe(false);
    expect(extractImagePayloads(withImage).dataUrls).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("counts remote image URLs separately so the caller can be told why", () => {
    const remote = {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
    };
    // Fetching that URL would aim the server at hosts the caller cannot reach.
    expect(extractImagePayloads(remote)).toEqual({ dataUrls: [], remoteUrls: 1 });
  });

  it("still flags a block type it can neither send nor name", () => {
    const audio = { messages: [{ role: "user", content: [{ type: "input_audio" }] }] };
    expect(hasUnsupportedBlocks(audio)).toBe(true);
    expect(hasUnsupportedBlocks({ messages: [{ role: "user", content: "plain" }] })).toBe(false);
  });

  it("produces an empty prompt when there is nothing but a system message", () => {
    const r = buildPromptFromOpenAiMessages({ messages: [{ role: "system", content: "only" }] });
    expect(r.prompt).toBe("");
  });

  it("totals usage in the completion response", async () => {
    const res = completionResponse("hi", "m1", { promptTokens: 4, completionTokens: 6 });
    const j = await res.json() as any;
    expect(j.object).toBe("chat.completion");
    expect(j.model).toBe("m1");
    expect(j.choices[0].message).toEqual({ role: "assistant", content: "hi" });
    expect(j.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
  });

  it("reports zero usage when the provider gave none", async () => {
    const j = await completionResponse("hi", "m1").json() as any;
    expect(j.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("shapes errors the way an OpenAI client parses them", async () => {
    const res = openAiError(404, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "nope", type: "server_error", code: "404" } });
  });
});
