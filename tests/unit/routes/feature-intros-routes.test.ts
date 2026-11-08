import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createFeatureIntroRoutes } from "../../../src/server/routes/feature-intros.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { FEATURE_INTROS, FEATURE_INTROS_CHANGED_EVENT } from "../../../src/shared/feature-intros.ts";

const INTRO = FEATURE_INTROS[0]!;
let events: unknown[] = [];
const app = () => new Hono().route("/api/feature-intros", createFeatureIntroRoutes((e) => events.push(e))).route("/api/settings", settingsRoutes);
const post = (path: string, body?: unknown) => app().request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }),
});
const view = async () => ((await (await app().request("/api/feature-intros")).json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  events = [];
  configService.set("feature_intros", {});
  const { ppm_tools: _drop, ...rest } = configService.get("ai");
  configService.set("ai", rest);
  getDb().run("DELETE FROM session_metadata");
});
afterEach(() => configService.set("feature_intros", {}));

describe("/api/feature-intros", () => {
  it("lists the pending feature with its copy and whether the install is in use", async () => {
    const data = await view();
    expect(data.pending).toEqual([JSON.parse(JSON.stringify(INTRO))]);
    expect(data.newInSettings).toEqual([]);
    expect(typeof data.isExistingUser).toBe("boolean");
  });

  it("records an answer, writes the six switches and tells every device", async () => {
    const res = await post(`/api/feature-intros/${INTRO.id}/answer`, { answer: "on" });
    expect(res.status).toBe(200);
    expect(configService.get("ai").ppm_tools).toEqual(Object.fromEntries(INTRO.tools.map((t) => [t, true])));
    expect(events).toEqual([{ type: FEATURE_INTROS_CHANGED_EVENT, id: INTRO.id, answer: "on" }]);
    expect((await view()).pending).toEqual([]);
  });

  it("rejects a bad answer and an unknown feature without broadcasting", async () => {
    for (const body of [{ answer: "yes" }, {}, null]) expect((await post(`/api/feature-intros/${INTRO.id}/answer`, body)).status).toBe(400);
    expect((await app().request(`/api/feature-intros/${INTRO.id}/answer`, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await post("/api/feature-intros/nope/answer", { answer: "on" })).status).toBe(404);
    expect((await post("/api/feature-intros/nope/skip")).status).toBe(404);
    expect(events).toEqual([]);
    expect(configService.get("ai").ppm_tools).toBeUndefined();
  });

  it("turns the feature off after three skips, marks it NEW in Settings until seen there", async () => {
    for (let n = 0; n < 3; n++) expect((await post(`/api/feature-intros/${INTRO.id}/skip`)).status).toBe(200);
    expect(events).toHaveLength(3);
    const data = await view();
    expect(data.pending).toEqual([]);
    expect(data.newInSettings).toEqual([INTRO.id]);
    expect((await post(`/api/feature-intros/${INTRO.id}/seen-in-settings`)).status).toBe(200);
    expect((await view()).newInSettings).toEqual([]);
  });

  it("settles the question when one of its switches is saved in Settings, without flipping the others", async () => {
    const res = await app().request("/api/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ppm_tools: { create_session: true } }),
    });
    expect(res.status).toBe(200);
    expect(configService.get("ai").ppm_tools).toEqual({
      search_sessions: false, list_session_turns: false, read_session_turns: false,
      create_session: true, send_to_session: false, session_status: false,
    });
    expect((await view()).pending).toEqual([]);
    expect(configService.get("feature_intros")?.[INTRO.id]).toMatchObject({ answer: "on", via: "settings" });
  });
});
