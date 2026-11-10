/**
 * The pure halves of Settings → PPM Assistant: which rows the manager table has, the read-only
 * zone line, the main-session label, a note's source line, how a template is stored, the notebook
 * meter, and that the General pane's save names none of the keys the other sub-tabs own.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { installDom } from "../../helpers/react-dom.tsx";

installDom();
const { managerTableRows, managerModeLabel } = await import("../../../src/web/lib/assistant-manager-table");
const { zoneLine } = await import("../../../src/web/components/settings/assistant/assistant-digest-quiet-section");
const { mainSessionLabel } = await import("../../../src/web/components/settings/assistant/assistant-session-picker");
const { noteSourceLabel } = await import("../../../src/web/components/settings/assistant/notebook-row");
const { templateToStore } = await import("../../../src/web/components/settings/assistant/manager-template-dialog");
const { notebookMeterLabel } = await import("../../../src/web/components/settings/assistant/assistant-notebook-section");
const { KEYS_SAVED_ELSEWHERE, saveGeneralAssistantSettings } = await import("../../../src/web/lib/assistant-settings-api");
const { api } = await import("../../../src/web/lib/api-client");

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const manager = (projectName: string) => ({
  projectName, projectPath: `/p/${projectName}`, sessionId: `m-${projectName}`, providerId: "claude", title: null,
  phase: "idle", permissionMode: "default", digest: true, telegramDetail: "full" as const, waiting: 0, rulesPending: false,
});

it("lists every registered project in order, then managers of removed projects, never the Assistant's own", () => {
  const rows = managerTableRows(
    [{ name: "nxsys" }, { name: "__assistant__" }, { name: "pex" }],
    [manager("pex"), manager("gone")],
  );
  expect(rows.map((r) => [r.projectName, r.manager?.sessionId ?? null, r.registered])).toEqual([
    ["nxsys", null, true], ["pex", "m-pex", true], ["gone", "m-gone", false],
  ]);
  expect(managerModeLabel("bypassPermissions")).toBe("Bypass permissions");
  expect(managerModeLabel("default")).toBe("Ask");
});

it("names the zone the times are in, and says when this device is elsewhere", () => {
  expect(zoneLine("Europe/London", "Europe/London")).toBe("Times are in Europe/London (this device's zone when you saved).");
  expect(zoneLine("Europe/London", "Asia/Saigon")).toContain("This device is on Asia/Saigon");
  expect(zoneLine(undefined, "Asia/Saigon")).toContain("the server's time zone");
});

it("labels a main-session choice with its title and start date", () => {
  expect(mainSessionLabel({ title: "Morning check", createdAt: "2026-11-10T09:00:00Z" })).toBe("Morning check · since 10/11");
  expect(mainSessionLabel({ title: "", createdAt: "not a date" })).toBe("Untitled session");
});

it("says who wrote a note, with no personal name", () => {
  expect(noteSourceLabel({ source: "user", updatedAt: Date.UTC(2026, 10, 4, 9) })).toBe("You · 04/11");
  expect(noteSourceLabel({ source: "assistant", updatedAt: Date.UTC(2026, 10, 10, 9) })).toBe("Assistant · 10/11");
});

it("stores the built-in template as empty, so a later PPM keeps it current", () => {
  expect(templateToStore("# Manager rules\n", "# Manager rules\n")).toBe("");
  expect(templateToStore("# Manager rules\n\n", "# Manager rules\n")).toBe("");
  expect(templateToStore("# Mine\n", "# Manager rules\n")).toBe("# Mine\n");
});

it("counts the notebook in grouped thousands", () => {
  expect(notebookMeterLabel(1400, 4000)).toBe("1,400 / 4,000 characters");
});

it("leaves the other sub-tabs' keys out of the General pane's save", async () => {
  const put = spyOn(api, "put").mockResolvedValue({} as never);
  spies.push(put);
  await saveGeneralAssistantSettings({
    default_provider: null, providers: {}, instructions: "x", mcp_servers: [], manager_default_mode: "plan", manager_template: "t",
    quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, digest: { enabled: true, time: "08:00" }, timezone: "Europe/London",
  });
  const body = put.mock.calls[0]![1] as Record<string, unknown>;
  for (const key of KEYS_SAVED_ELSEWHERE) expect(key in body).toBe(false);
  expect(body.instructions).toBe("x");
});
