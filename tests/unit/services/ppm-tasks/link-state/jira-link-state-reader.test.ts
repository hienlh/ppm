import { describe, expect, it } from "bun:test";
import { JiraApiError } from "../../../../../src/services/jira-api-client.ts";
import { JIRA_BATCH, mapIssue, readJiraStates, type JiraTransport } from "../../../../../src/services/ppm-tasks/link-state/jira-link-state-reader.ts";
import type { JiraIssue } from "../../../../../src/types/jira.ts";

const CREDS = { baseUrl: "https://acme.atlassian.net", email: "a@b.c", token: "t" };

function issue(key: string, status = "In Progress", category = "indeterminate"): JiraIssue {
  return {
    key, id: key,
    fields: {
      summary: `Summary of ${key}`, description: null,
      status: { name: status, id: "1", statusCategory: { key: category } } as JiraIssue["fields"]["status"],
      priority: null, assignee: { accountId: "x", displayName: "Lan" }, updated: "2026-11-15T10:00:00.000+0000", created: "",
    },
  };
}

function transport(over: Partial<JiraTransport> = {}): JiraTransport & { searches: string[][] } {
  const searches: string[][] = [];
  return {
    searches,
    credentialsFor: () => ({ creds: CREDS, baseUrl: CREDS.baseUrl }),
    paused: () => false,
    search: async (_c, keys) => { searches.push(keys); return keys.map((k) => issue(k)); },
    get: async (_c, key) => issue(key),
    ...over,
  };
}

describe("readJiraStates", () => {
  it("batches up to 50 keys per search and maps each issue", async () => {
    const t = transport();
    const refs = Array.from({ length: 60 }, (_, i) => `NX-${i + 1}`);
    const out = (await readJiraStates("p", refs, t))!;
    expect(JIRA_BATCH).toBe(50);
    expect(t.searches.map((s) => s.length)).toEqual([50, 10]);
    expect(out.get("NX-7")).toEqual({
      state: { status: "In Progress", category: "indeterminate", assignee: "Lan", updated: "2026-11-15T10:00:00.000+0000", summary: "Summary of NX-7" },
      error: null,
    });
  });

  it("says when the project has no Jira config, without asking anything", async () => {
    const t = transport({ credentialsFor: () => ({ problem: "no Jira config for this project" }) });
    expect((await readJiraStates("p", ["NX-1"], t))!.get("NX-1")).toEqual({ state: null, error: "no Jira config for this project" });
    expect(t.searches).toEqual([]);
  });

  it("asks nothing while the site has paused us", async () => {
    const t = transport({ paused: () => true });
    expect(await readJiraStates("p", ["NX-1"], t)).toBeNull();
    expect(t.searches).toEqual([]);
  });

  it("retries a rejected batch key by key, so one bad key does not blank the rest", async () => {
    const t = transport({
      search: async () => { throw new JiraApiError("The value 'NX-404' does not exist for the field 'key'.", 400); },
      get: async (_c, key) => { if (key === "NX-404") throw new JiraApiError("nope", 404); return issue(key, "Done", "done"); },
    });
    const out = (await readJiraStates("p", ["nx-1", "NX-404"], t))!;
    expect((out.get("nx-1")!.state as { category: string }).category).toBe("done");
    expect(out.get("NX-404")).toEqual({ state: null, error: "issue not found or no access" });
  });

  it("an issue missing from the answer reads as not found; a non-key never reaches Jira", async () => {
    const t = transport({ search: async () => [issue("NX-1")] });
    const out = (await readJiraStates("p", ["NX-1", "NX-2", "hello"], t))!;
    expect(out.get("NX-2")!.error).toBe("issue not found or no access");
    expect(out.get("hello")!.error).toBe("not a Jira key");
  });
});

describe("Jira rate limits", () => {
  it("stops the key-by-key retry at the first 429", async () => {
    const asked: string[] = [];
    const t = transport({
      search: async () => { throw new JiraApiError("bad key", 400); },
      get: async (_c, key) => { asked.push(key); throw new JiraApiError("slow down", 429); },
    });
    const out = (await readJiraStates("p", ["NX-1", "NX-2", "NX-3"], t))!;
    expect(asked).toEqual(["NX-1"]);
    expect(out.get("NX-3")).toEqual({ state: null, error: "Jira 429" });
  });
});

describe("mapIssue", () => {
  it("tolerates an unknown status category and no assignee", () => {
    const i = issue("NX-1", "Weird", "mystery");
    i.fields.assignee = null;
    expect(mapIssue(i)).toMatchObject({ status: "Weird", category: null, assignee: null });
  });
});
