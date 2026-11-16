/**
 * `jira_config_get` against a real `jira_config` row in a scratch PPM folder: the saved token,
 * its ciphertext and Jira's own error text never reach the answer, a test reports ok or a status,
 * and tests are rate-limited per Assistant session.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb, getProjects, upsertProject } from "../../../src/services/db.service.ts";
import { upsertConfig } from "../../../src/services/jira-config.service.ts";
import { createWatcher } from "../../../src/services/jira-watcher-db.service.ts";
import { JiraApiError } from "../../../src/services/jira-api-client.ts";
import type { JiraCredentials } from "../../../src/types/jira.ts";
import {
  _resetJiraTestLimit, jiraConfigGet, realJiraToolDeps, type JiraToolDeps,
} from "../../../src/services/assistant-mcp/assistant-jira-config-tool.ts";
import { JIRA_TESTS_PER_WINDOW, JIRA_TEST_WINDOW_MS } from "../../../src/services/assistant-mcp/assistant-system-tool-definitions.ts";

const TOKEN = "ATATT3xFfGF0-fake-jira-token-0123456789abcdef";
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

let now = 1_800_000_000_000;
const sent: JiraCredentials[] = [];
let answer: () => Promise<unknown> = async () => true;
const deps = (): JiraToolDeps => ({
  ...realJiraToolDeps,
  now: () => now,
  test: async (creds) => { sent.push(creds); return answer(); },
});

const projectId = (name: string) => getProjects().find((p) => p.name === name)!.id;
const ciphertext = () => (getDb().query("SELECT api_token_encrypted AS c FROM jira_config WHERE project_id = ?").get(projectId("jira-proj")) as { c: string }).c;

beforeEach(() => {
  _resetJiraTestLimit();
  sent.length = 0;
  answer = async () => true;
  getDb().exec("DELETE FROM jira_config");
  upsertProject("/tmp/jira-proj", "jira-proj");
  upsertProject("/tmp/plain-proj", "plain-proj");
  const config = upsertConfig(projectId("jira-proj"), "https://acme.atlassian.net", "dev@acme.test", TOKEN);
  createWatcher(config.id, "bugs", "project = ACME");
});

describe("jira_config_get", () => {
  it("shows each project's settings and never the token or its ciphertext", async () => {
    const out = text(await jiraConfigGet("s1", {}, deps()));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(ciphertext());
    const rows = JSON.parse(out).projects as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.project === "jira-proj")).toEqual({
      project: "jira-proj", configured: true, baseUrl: "https://acme.atlassian.net", email: "dev@acme.test",
      tokenSaved: true, watchers: 1, credentialsProblem: null,
    });
    expect(rows.find((r) => r.project === "plain-proj")).toEqual({ project: "plain-proj", configured: false });
    expect(sent).toHaveLength(0);
  });

  it("narrows to one project and refuses a name that is not registered", async () => {
    const one = JSON.parse(text(await jiraConfigGet("s1", { project: "jira-proj" }, deps())));
    expect(one.projects).toHaveLength(1);
    const missing = await jiraConfigGet("s1", { project: "nope" }, deps()) as { isError?: boolean };
    expect(missing.isError).toBe(true);
  });

  it("explains a cleared token instead of testing it", async () => {
    upsertConfig(projectId("jira-proj"), "https://acme.atlassian.net", "dev@acme.test", null);
    const row = JSON.parse(text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps()))).projects[0];
    expect(row.tokenSaved).toBe(false);
    expect(row.credentialsProblem).toContain("no API token");
    expect(row.test).toContain("not run");
    expect(sent).toHaveLength(0);
  });

  it("tests the saved login and answers ok", async () => {
    const row = JSON.parse(text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps()))).projects[0];
    expect(row.test).toEqual({ ok: true });
    expect(sent).toEqual([{ baseUrl: "https://acme.atlassian.net", email: "dev@acme.test", token: TOKEN }]);
  });

  it("answers a failed test with the status and PPM's reason, not Jira's body", async () => {
    answer = async () => { throw new JiraApiError(`Jira API 401: bad credentials for token ${TOKEN}`, 401); };
    const out = text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps()));
    expect(out).not.toContain(TOKEN);
    expect(JSON.parse(out).projects[0].test).toEqual({ ok: false, status: 401, reason: expect.stringContaining("refused the login") });
    answer = async () => { throw new TypeError(`fetch failed for ${TOKEN}`); };
    const offline = text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps()));
    expect(offline).not.toContain(TOKEN);
    expect(JSON.parse(offline).projects[0].test).toEqual({ ok: false, status: null, reason: "the site could not be reached" });
  });

  it(`allows ${JIRA_TESTS_PER_WINDOW} tests per window and per session`, async () => {
    for (let i = 0; i < JIRA_TESTS_PER_WINDOW; i++) await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps());
    const limited = JSON.parse(text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps())));
    expect(limited.projects[0].test).toBe("rate-limited");
    expect(limited.note).toContain("limited");
    expect(sent).toHaveLength(JIRA_TESTS_PER_WINDOW);
    // Another conversation has its own allowance; this one's comes back once the window passes.
    expect(JSON.parse(text(await jiraConfigGet("s2", { project: "jira-proj", test: true }, deps()))).projects[0].test).toEqual({ ok: true });
    now += JIRA_TEST_WINDOW_MS;
    expect(JSON.parse(text(await jiraConfigGet("s1", { project: "jira-proj", test: true }, deps()))).projects[0].test).toEqual({ ok: true });
  });

  it("refuses arguments of the wrong type", async () => {
    expect((await jiraConfigGet("s1", { test: "yes" }, deps()) as { isError?: boolean }).isError).toBe(true);
    expect((await jiraConfigGet("s1", { project: 3 }, deps()) as { isError?: boolean }).isError).toBe(true);
  });
});
