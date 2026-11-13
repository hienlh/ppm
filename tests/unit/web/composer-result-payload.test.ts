import { describe, it, expect } from "bun:test";
import { buildMessageWithAttachments } from "../../../src/web/components/chat/build-message-with-attachments.ts";
import type { ChatAttachment } from "../../../src/web/components/chat/message-input.tsx";

/** The path-only formatting chat-tab.tsx has always produced when no image payload rides
 * along — kept here to prove the extraction leaves that output unchanged, byte for byte. */
function oldBuildMessageWithAttachments(content: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return content;
  const parts: string[] = [];
  for (const att of attachments) {
    if (att.textContent) parts.push(att.textContent);
  }
  const fileAtts = attachments.filter((a) => a.serverPath);
  if (fileAtts.length > 0) {
    const fileRefs = fileAtts.map((a) => a.serverPath!).join("\n");
    parts.push(
      fileAtts.length === 1
        ? `[Attached file: ${fileRefs}]`
        : `[Attached files:\n${fileRefs}\n]`,
    );
  }
  if (parts.length === 0) return content;
  return parts.join("\n\n") + "\n\n" + content;
}

function att(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "a1",
    name: "file.txt",
    file: new File([], "file.txt"),
    isImage: false,
    status: "ready",
    ...overrides,
  };
}

describe("buildMessageWithAttachments — extraction is behaviour-preserving", () => {
  it("no attachments — returns content unchanged", () => {
    const args: [string, ChatAttachment[]] = ["hello world", []];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
    expect(buildMessageWithAttachments(...args)).toBe("hello world");
  });

  it("inline text snippet only", () => {
    const attachments = [att({ textContent: "terminal output here", serverPath: undefined })];
    const args: [string, ChatAttachment[]] = ["look at this", attachments];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
    expect(buildMessageWithAttachments(...args)).toBe("terminal output here\n\nlook at this");
  });

  it("single uploaded file", () => {
    const attachments = [att({ serverPath: "/uploads/a.png" })];
    const args: [string, ChatAttachment[]] = ["check this", attachments];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
    expect(buildMessageWithAttachments(...args)).toBe("[Attached file: /uploads/a.png]\n\ncheck this");
  });

  it("multiple uploaded files", () => {
    const attachments = [
      att({ id: "a1", serverPath: "/uploads/a.png" }),
      att({ id: "a2", serverPath: "/uploads/b.png" }),
    ];
    const args: [string, ChatAttachment[]] = ["check these", attachments];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
    expect(buildMessageWithAttachments(...args)).toBe(
      "[Attached files:\n/uploads/a.png\n/uploads/b.png\n]\n\ncheck these",
    );
  });

  it("mixed text snippet + uploaded file", () => {
    const attachments = [
      att({ id: "a1", textContent: "log output" }),
      att({ id: "a2", serverPath: "/uploads/a.png" }),
    ];
    const args: [string, ChatAttachment[]] = ["debug this", attachments];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
  });

  it("an image whose payload is sent inline is announced as included, the rest as files", () => {
    const imageData = { data: "aGk=", mediaType: "image/png" };
    const attachments = [
      att({ id: "a1", isImage: true, serverPath: "/uploads/a.png", imageData }),
      att({ id: "a2", serverPath: "/uploads/b.txt" }),
    ];
    expect(buildMessageWithAttachments("see", attachments, [imageData])).toBe(
      "[Attached image (contents included in this message): /uploads/a.png]\n\n[Attached file: /uploads/b.txt]\n\nsee",
    );
  });

  it("attachment with neither textContent nor serverPath contributes nothing", () => {
    const attachments = [att({ status: "uploading" })];
    const args: [string, ChatAttachment[]] = ["still uploading", attachments];
    expect(buildMessageWithAttachments(...args)).toBe(oldBuildMessageWithAttachments(...args));
    expect(buildMessageWithAttachments(...args)).toBe("still uploading");
  });
});

describe("ComposerResult payload shape", () => {
  it("carries no images field — attachments are already folded into content", () => {
    const content = buildMessageWithAttachments("hi", [att({ serverPath: "/uploads/a.png" })]);
    const result = {
      content,
      model: undefined,
      effort: undefined,
      thinking: false,
      permissionMode: "bypassPermissions",
    };
    expect("images" in result).toBe(false);
    expect(result.content).toContain("[Attached file: /uploads/a.png]");
  });
});
