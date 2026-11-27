/**
 * The pinned card desk on Telegram is asked about once, as one setting (`clawbot.card_desk`): the
 * tour's answer writes it without touching the bridge's other settings, a choice made in Settings
 * first settles the question, and saving any other Telegram setting does not answer it for the user.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { answerFeatureIntro, featureIntrosView, readFeatureIntroStates } from "../../../src/services/feature-intros.service.ts";
import { cardDeskEnabled } from "../../../src/services/assistant-telegram/assistant-telegram-cards-desk-store.ts";
import { FEATURE_INTROS } from "../../../src/shared/feature-intros.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";

const ID = "telegram-card-desk-2026-11";
let saved: unknown;
const clawbot = () => configService.get("clawbot") as Record<string, unknown> | undefined;

beforeEach(() => {
  saved = configService.get("clawbot");
  configService.set("feature_intros", Object.fromEntries(FEATURE_INTROS.filter((i) => i.id !== ID).map((i) => [i.id, { answer: "off" as const, skips: 0, via: "tour" as const }])));
  configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 700 } as never);
});
afterEach(() => configService.set("clawbot", saved as never));

describe("Telegram card desk introduction", () => {
  it("is asked while undecided, stands for the one setting, and is off until answered", () => {
    const intro = FEATURE_INTROS.find((i) => i.id === ID)!;
    expect(intro.setting).toBe("telegram_card_desk");
    expect(intro.tools).toEqual([]);
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([ID]);
    expect(cardDeskEnabled()).toBe(false);
  });

  it("Turn on writes clawbot.card_desk and keeps the bridge's other settings", () => {
    answerFeatureIntro(ID, "on");
    expect(clawbot()).toMatchObject({ card_desk: true, show_tool_calls: true, debounce_ms: 700 });
    expect(cardDeskEnabled()).toBe(true);
    expect(featureIntrosView().pending).toEqual([]);
  });

  it("a choice made in Settings settles the question without asking", async () => {
    const app = new Hono().route("/api/settings", settingsRoutes);
    const res = await app.request("http://localhost/api/settings/clawbot", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_desk: false }),
    });
    expect(res.status).toBe(200);
    expect(featureIntrosView().pending).toEqual([]);
    expect(readFeatureIntroStates()[ID]).toMatchObject({ answer: "off", via: "settings" });
  });

  it("saving another Telegram setting leaves the question open", async () => {
    const app = new Hono().route("/api/settings", settingsRoutes);
    const res = await app.request("http://localhost/api/settings/clawbot", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ show_tool_calls: false }),
    });
    expect(res.status).toBe(200);
    expect(clawbot()?.card_desk).toBeUndefined();
    expect(featureIntrosView().pending.map((i) => i.id)).toEqual([ID]);
  });

  it("refuses a card_desk that is not true or false", async () => {
    const app = new Hono().route("/api/settings", settingsRoutes);
    const res = await app.request("http://localhost/api/settings/clawbot", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_desk: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
