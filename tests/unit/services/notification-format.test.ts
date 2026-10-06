import { describe, expect, it } from "bun:test";
import {
  describeApprovalInput,
  formatPushNotification,
  formatTelegramNotification,
  notificationPath,
  truncateText,
} from "../../../src/services/notification-format.ts";
import type { NotificationPayload } from "../../../src/services/notification.service.ts";

const base: NotificationPayload = { title: "Chat completed", body: "ppm — Fix <login>", project: "ppm", sessionId: "s1" };

describe("notificationPath", () => {
  it("opens the session's chat in its project, by name", () => {
    expect(notificationPath({ project: "my app", sessionId: "a/b" })).toBe("/project/my%20app?openChat=a%2Fb");
    expect(notificationPath({ project: "ppm", sessionId: "" })).toBe("/project/ppm");
  });

  it("names the provider the way a chat URL does, or a Codex thread would open as Claude", () => {
    expect(notificationPath({ project: "ppm", sessionId: "s1", providerId: "codex" })).toBe("/project/ppm?openChat=codex%2Fs1");
  });

  it("opens PPM itself when there is no project — never a path posing as one", () => {
    expect(notificationPath({ project: "", sessionId: "s1" })).toBe("/");
  });
});

describe("formatTelegramNotification", () => {
  it("escapes everything that came from a session, the link included", () => {
    const html = formatTelegramNotification(
      { ...base, detail: "if (a < b && c) { … }", detailStyle: "quote" },
      "dev<box>",
      "https://ppm.example/project/ppm?openChat=s1&x=\"1\"",
    );
    expect(html).toBe(
      "<b>dev&lt;box&gt; — Chat completed</b>\nppm — Fix &lt;login&gt;\n"
      + "<blockquote>if (a &lt; b &amp;&amp; c) { … }</blockquote>\n\n"
      + "<a href=\"https://ppm.example/project/ppm?openChat=s1&amp;x=&quot;1&quot;\">Open in PPM</a>",
    );
  });

  it("puts commands and paths in a code block, and leaves the link out when there is none", () => {
    const html = formatTelegramNotification({ ...base, detail: "rm -rf dist", detailStyle: "code" }, "devbox", null);
    expect(html).toBe("<b>devbox — Chat completed</b>\nppm — Fix &lt;login&gt;\n<pre>rm -rf dist</pre>");
  });

  it("keeps a long answer to a preview", () => {
    const html = formatTelegramNotification({ ...base, detail: "x".repeat(5000) }, "devbox", null);
    expect(html.length).toBeLessThan(500);
    expect(html).toContain("…</blockquote>");
  });
});

describe("formatPushNotification", () => {
  it("names the machine in the title and puts the detail under the context line", () => {
    expect(formatPushNotification({ ...base, detail: "Done.\n\n\n\nAll green." }, "devbox")).toEqual({
      title: "Chat completed · devbox",
      body: "ppm — Fix <login>\nDone.\n\nAll green.",
    });
    expect(formatPushNotification(base, "devbox").body).toBe("ppm — Fix <login>");
  });
});

describe("describeApprovalInput", () => {
  it("quotes the question, counting the rest", () => {
    expect(describeApprovalInput("AskUserQuestion", { questions: [{ question: "Which DB?" }, { question: "Port?" }] }))
      .toEqual({ detail: "Which DB? (+1 more)", detailStyle: "quote" });
  });

  it("shows the command, the file or the URL waiting for approval", () => {
    expect(describeApprovalInput("Bash", { command: "git push --force", description: "x" })).toEqual({ detail: "git push --force", detailStyle: "code" });
    expect(describeApprovalInput("exec", { command: ["npm", "publish"] })).toEqual({ detail: "npm publish", detailStyle: "code" });
    expect(describeApprovalInput("Edit", { file_path: "/srv/app/.env", old_string: "a" })).toEqual({ detail: "/srv/app/.env", detailStyle: "code" });
    expect(describeApprovalInput("WebFetch", { url: "https://example.com" })).toEqual({ detail: "https://example.com", detailStyle: "code" });
  });

  it("says nothing when there is nothing worth saying", () => {
    expect(describeApprovalInput("TodoWrite", { todos: [] })).toEqual({});
    expect(describeApprovalInput("AskUserQuestion", { questions: [] })).toEqual({});
    expect(describeApprovalInput("Bash", null)).toEqual({});
  });
});

describe("truncateText", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(truncateText("  short  ", 10)).toBe("short");
    expect(truncateText("abcdefghij", 5)).toBe("abcd…");
  });
});
