import { describe, it, expect, spyOn } from "bun:test";
import { clampInterval } from "../../src/services/jira-watcher.service.ts";

describe("clampInterval", () => {
  it("clamps below 30s to 30s", () => {
    expect(clampInterval(1000)).toBe(30_000);
    expect(clampInterval(0)).toBe(30_000);
    expect(clampInterval(-1)).toBe(30_000);
  });

  it("clamps above 60m to 60m", () => {
    expect(clampInterval(7_200_000)).toBe(3_600_000);
    expect(clampInterval(999_999_999)).toBe(3_600_000);
  });

  it("passes through valid intervals", () => {
    expect(clampInterval(30_000)).toBe(30_000);
    expect(clampInterval(120_000)).toBe(120_000);
    expect(clampInterval(3_600_000)).toBe(3_600_000);
  });
});

describe("buildPrompt", () => {
  // Import the service to test buildPrompt — it's a method on the class
  // but we can test it via the singleton
  it("renders default template", async () => {
    const { jiraWatcherService } = await import("../../src/services/jira-watcher.service.ts");
    const watcher = { prompt_template: null } as any;
    const issue = {
      key: "BUG-123",
      fields: {
        summary: "Login broken",
        description: "Users can't login",
        status: { name: "Open" },
        priority: { name: "High" },
      },
    } as any;
    const prompt = jiraWatcherService.buildPrompt(watcher, issue);
    expect(prompt).toContain("BUG-123");
    expect(prompt).toContain("Login broken");
    expect(prompt).toContain("Users can't login");
  });

  it("renders custom template with variable substitution", async () => {
    const { jiraWatcherService } = await import("../../src/services/jira-watcher.service.ts");
    const watcher = {
      prompt_template: "Fix {issue_key}: {summary} (priority: {priority}, status: {status})",
    } as any;
    const issue = {
      key: "TASK-42",
      fields: {
        summary: "Add feature",
        description: null,
        status: { name: "In Progress" },
        priority: { name: "Medium" },
      },
    } as any;
    const prompt = jiraWatcherService.buildPrompt(watcher, issue);
    expect(prompt).toBe("Fix TASK-42: Add feature (priority: Medium, status: In Progress)");
  });

  it("handles null description in custom template", async () => {
    const { jiraWatcherService } = await import("../../src/services/jira-watcher.service.ts");
    const watcher = { prompt_template: "{description}" } as any;
    const issue = {
      key: "X-1",
      fields: { summary: "s", description: null, status: { name: "Open" }, priority: null },
    } as any;
    const prompt = jiraWatcherService.buildPrompt(watcher, issue);
    expect(prompt).toBe("(no description)");
  });

  it("handles null priority in custom template", async () => {
    const { jiraWatcherService } = await import("../../src/services/jira-watcher.service.ts");
    const watcher = { prompt_template: "Priority: {priority}" } as any;
    const issue = {
      key: "X-1",
      fields: { summary: "s", description: null, status: { name: "Open" }, priority: null },
    } as any;
    const prompt = jiraWatcherService.buildPrompt(watcher, issue);
    expect(prompt).toBe("Priority: None");
  });
});

describe("poll failure log", () => {
  it("logs a watcher's failure when it changes, a refusal as an error, and the recovery once", async () => {
    const { jiraWatcherService } = await import("../../src/services/jira-watcher.service.ts");
    const { JiraApiError } = await import("../../src/services/jira-api-client.ts");
    const svc = jiraWatcherService as unknown as {
      pollFailed(id: number, e: unknown, name?: string): void;
      pollSucceeded(watcher: { id: number; name: string }): void;
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const info = spyOn(console, "log").mockImplementation(() => {});
    const mine = (spy: typeof warn) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Watcher 9001"));
    try {
      const refused = new JiraApiError("Jira API 401: Unauthorized", 401);
      svc.pollFailed(9001, refused, "Bugs");
      svc.pollFailed(9001, refused, "Bugs");
      expect(mine(error)).toEqual(['[jira] Watcher 9001 "Bugs" poll failed: Jira API 401: Unauthorized']);

      // Another failure is a change; a network error may pass, so it is a warning.
      svc.pollFailed(9001, new Error("Network timeout"), "Bugs");
      expect(mine(warn)).toEqual(['[jira] Watcher 9001 "Bugs" poll failed: Network timeout']);

      // A rate limit is logged where the pause is decided, not here.
      svc.pollFailed(9001, new JiraApiError("Jira API 429: slow down", 429), "Bugs");
      expect(mine(warn).length + mine(error).length).toBe(2);

      svc.pollSucceeded({ id: 9001, name: "Bugs" });
      svc.pollSucceeded({ id: 9001, name: "Bugs" });
      expect(mine(info)).toEqual(['[jira] Watcher 9001 "Bugs" polls again']);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });
});
