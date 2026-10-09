/**
 * The approval card shows what will actually happen: an Assistant endpoint card leads with the
 * server's summary and shows the SQL or message in full, wrapped rather than scrolled sideways,
 * with its statement count and any warning; a provider's card keeps its raw input, also wrapped.
 * A chat's card follows the server: a greeting that names no card takes it away.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ApprovalCard } = await import("../../../src/web/components/chat/approval-card");
const { approvalAfterGreeting, approvalFromWire } = await import("../../../src/web/lib/approval-request");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const SQL = "UPDATE users SET admin = 1 WHERE id = 7;\nDROP TABLE audit_log;";

it("shows an endpoint card's summary and its full SQL, wrapped, with the statement count", async () => {
  const answers: Array<[string, boolean]> = [];
  view = await mount(<ApprovalCard
    approval={{
      requestId: "r1", tool: "db_query", input: { sql: SQL },
      summary: {
        headline: "Run 2 SQL statements that may change data on \"prod\"",
        facts: [{ label: "Connection", value: "prod (postgres)" }, { label: "Writes", value: "Allowed", tone: "warning" }],
        body: { label: "SQL", text: SQL, format: "sql" },
        statementCount: 2,
        warning: "That chat runs every tool without asking",
      },
    }}
    onRespond={(id, ok) => answers.push([id, ok])}
  />);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Run 2 SQL statements that may change data on \"prod\"");
  expect(text).toContain("SQL · 2 statements");
  expect(text).toContain("prod (postgres)");
  expect(text).toContain("That chat runs every tool without asking");
  const pre = view.container.querySelector("pre")!;
  expect(pre.textContent).toBe(SQL);
  expect(pre.className).toContain("whitespace-pre-wrap");
  expect(pre.className).not.toContain("overflow-x-auto");
  const buttons = [...view.container.querySelectorAll("button")];
  await click(buttons.find((b) => b.textContent === "Deny")!);
  expect(answers).toEqual([["r1", false]]);
});

it("keeps a provider's card on its raw input, wrapped too", async () => {
  view = await mount(<ApprovalCard approval={{ requestId: "r2", tool: "Bash", input: { command: "rm -rf build" } }} onRespond={() => {}} />);
  expect(view.container.textContent).toContain("Tool Approval Required");
  const pre = view.container.querySelector("pre")!;
  expect(pre.textContent).toContain("rm -rf build");
  expect(pre.className).toContain("whitespace-pre-wrap");
});

it("follows the server's greeting: none named means none shown", () => {
  const shown = approvalFromWire({ requestId: "r1", tool: "db_query", input: {}, summary: { headline: "h", facts: [] } });
  expect(shown).toEqual({ requestId: "r1", tool: "db_query", input: {}, summary: { headline: "h", facts: [] } });
  expect(approvalAfterGreeting(shown, { pendingApproval: null })).toBeNull();
  expect(approvalAfterGreeting(shown, { phase: "idle" })).toBe(shown);
  expect(approvalAfterGreeting(null, { pendingApproval: { requestId: "r9", tool: "Bash", input: { command: "ls" } } }))
    .toEqual({ requestId: "r9", tool: "Bash", input: { command: "ls" } });
  // A garbled summary is dropped rather than shown half-read.
  expect(approvalFromWire({ requestId: "r3", tool: "x", input: {}, summary: { facts: "nope" } })).toEqual({ requestId: "r3", tool: "x", input: {} });
});

// Built from code points so this file holds no invisible characters of its own.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const LSEP = String.fromCodePoint(0x2028);

it("shows a direction override or invisible character as a marker, and says so", async () => {
  const sql = `SELECT 1; -- ${RLO}DROP TABLE users${ZWSP};${LSEP}x`;
  view = await mount(<ApprovalCard
    approval={{
      requestId: "r4", tool: "db_query", input: { sql },
      summary: { headline: "Run SQL", facts: [{ label: "Chat", value: `Notes${RLO}cba` }], body: { label: "SQL", text: sql, format: "sql" } },
    }}
    onRespond={() => {}}
  />);
  const pre = view.container.querySelector("pre")!;
  expect(pre.textContent).toBe("SELECT 1; -- ⟨U+202E⟩DROP TABLE users⟨U+200B⟩;⟨U+2028⟩x");
  expect(view.container.textContent).toContain("Notes⟨U+202E⟩cba");
  expect(view.container.textContent).not.toContain(RLO);
  expect(view.container.textContent).toContain("invisible or text-direction characters");
});

it("does the same for a provider card's raw input", async () => {
  view = await mount(<ApprovalCard approval={{ requestId: "r5", tool: "Bash", input: { command: `rm -rf ${RLO}build` } }} onRespond={() => {}} />);
  expect(view.container.querySelector("pre")!.textContent).toContain("rm -rf ⟨U+202E⟩build");
  expect(view.container.textContent).toContain("invisible or text-direction characters");
});

it("adds no warning to ordinary text, tabs and newlines included", async () => {
  const sql = "SELECT 1;\n\tSELECT 'é — ✓';";
  view = await mount(<ApprovalCard
    approval={{ requestId: "r6", tool: "db_query", input: {}, summary: { headline: "h", facts: [], body: { label: "SQL", text: sql, format: "sql" } } }}
    onRespond={() => {}}
  />);
  expect(view.container.querySelector("pre")!.textContent).toBe(sql);
  expect(view.container.textContent).not.toContain("text-direction characters");
});
