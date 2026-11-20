import { describe, expect, it } from "bun:test";
import { featureIntroSettingsLink, parseFeatureIntrosView } from "../../../src/web/lib/onboarding/feature-intros-client";

const view = (intro: Record<string, unknown>) => ({ pending: [intro], isExistingUser: true, newInSettings: [] });

describe("parseFeatureIntrosView", () => {
  it("keeps a setting-backed feature's setting, so the step links to where it lives", () => {
    const parsed = parseFeatureIntrosView(view({
      id: "assistant-full-mode-2026-11", title: "t", body: "b", tools: [], setting: "assistant_permission_mode", since: "2026-11",
    }));
    expect(parsed?.pending[0]?.setting).toBe("assistant_permission_mode");
  });

  it("drops a setting it does not know, and keeps tool features as they were", () => {
    const odd = parseFeatureIntrosView(view({ id: "x", title: "t", body: "b", tools: [], setting: "something_else" }));
    expect(odd?.pending[0]?.setting).toBeUndefined();
    const tools = parseFeatureIntrosView(view({ id: "y", title: "t", body: "b", tools: ["create_session"] }));
    expect(tools?.pending[0]).toEqual({ id: "y", title: "t", body: "b", tools: ["create_session"], since: "" });
  });

  it("keeps the voice messages setting", () => {
    const parsed = parseFeatureIntrosView(view({ id: "voice", title: "t", body: "b", tools: [], setting: "voice_messages" }));
    expect(parsed?.pending[0]?.setting).toBe("voice_messages");
  });
});

describe("featureIntroSettingsLink", () => {
  it("sends each kind of feature to the pane where it is decided", () => {
    expect(featureIntroSettingsLink({ setting: "voice_messages" }).category).toBe("voice");
    expect(featureIntroSettingsLink({ setting: "assistant_permission_mode" }).category).toBe("assistant");
    expect(featureIntroSettingsLink({}).category).toBe("tools");
  });
});
