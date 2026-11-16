/**
 * Where a task link opens: a Jira key on its project's Jira site, a PR on GitHub, a URL as given,
 * and nothing that is not `http:`/`https:` — a `javascript:` URL saved as a link must never reach
 * an `href`.
 */
import { describe, expect, it } from "bun:test";
import { jiraSiteUrl, safeWebUrl, taskLinkWebHref } from "../../../src/shared/ppm-task-link-href.ts";

describe("taskLinkWebHref", () => {
  it("opens a Jira key on the project's Jira site", () => {
    expect(taskLinkWebHref({ kind: "jira", ref: "AL-6284" }, { jiraSite: "https://alpha.atlassian.net" }))
      .toBe("https://alpha.atlassian.net/browse/AL-6284");
    // A config saved with a trailing slash, or a Jira Server under a context path.
    expect(taskLinkWebHref({ kind: "jira", ref: "AL-1" }, { jiraSite: "https://alpha.atlassian.net/" })).toBe("https://alpha.atlassian.net/browse/AL-1");
    expect(taskLinkWebHref({ kind: "jira", ref: "BE-2" }, { jiraSite: "http://beta.example:8080/jira/?x=1#y" })).toBe("http://beta.example:8080/jira/browse/BE-2");
  });

  it("gives a Jira key no address when the project has no Jira site", () => {
    expect(taskLinkWebHref({ kind: "jira", ref: "AL-6284" })).toBeNull();
    expect(taskLinkWebHref({ kind: "jira", ref: "AL-6284" }, { jiraSite: null })).toBeNull();
    expect(taskLinkWebHref({ kind: "jira", ref: "AL-6284" }, { jiraSite: "" })).toBeNull();
  });

  it("opens a Jira issue saved as a plain URL link at that URL", () => {
    expect(taskLinkWebHref({ kind: "url", ref: "https://alpha.atlassian.net/browse/AL-6284" })).toBe("https://alpha.atlassian.net/browse/AL-6284");
  });

  it("opens a PR on GitHub", () => {
    expect(taskLinkWebHref({ kind: "pr", ref: "alpha/beta-web#2424" })).toBe("https://github.com/alpha/beta-web/pull/2424");
    expect(taskLinkWebHref({ kind: "pr", ref: "not a pr" })).toBeNull();
  });

  it("opens a URL as it is, and a chat nowhere outside PPM", () => {
    expect(taskLinkWebHref({ kind: "url", ref: "https://example.com/a?b=1" })).toBe("https://example.com/a?b=1");
    expect(taskLinkWebHref({ kind: "session", ref: "c0ffee" })).toBeNull();
  });

  it("refuses every scheme other than http and https", () => {
    for (const ref of [
      "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>x</script>",
      "vbscript:msgbox", "file:///etc/passwd", "ftp://example.com/a", "mailto:a@example.com", "//example.com", "example.com",
    ]) {
      expect(taskLinkWebHref({ kind: "url", ref })).toBeNull();
      expect(taskLinkWebHref({ kind: "jira", ref: "AL-1" }, { jiraSite: ref })).toBeNull();
    }
  });

  it("refuses a Jira site that carries credentials or a ref that is not a key", () => {
    expect(jiraSiteUrl("https://user:pass@alpha.atlassian.net")).toBeNull();
    expect(taskLinkWebHref({ kind: "jira", ref: "../../evil" }, { jiraSite: "https://alpha.atlassian.net" })).toBeNull();
  });

  it("reads a web address the way the browser would", () => {
    expect(safeWebUrl("https://example.com")).toBe("https://example.com/");
    expect(safeWebUrl("not a url")).toBeNull();
  });
});
