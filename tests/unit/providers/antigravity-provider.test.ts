import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHttpPortFromLsLog } from "../../../src/providers/antigravity/antigravity-connection.ts";
import { AntigravityProvider } from "../../../src/providers/antigravity/antigravity-provider.ts";
import {
  parseAntigravityModels,
  resolveAntigravityModelId,
  ANTIGRAVITY_FALLBACK_MODELS,
} from "../../../src/providers/antigravity/antigravity-models.ts";
import { parseAntigravityUsage } from "../../../src/providers/antigravity/antigravity-usage.ts";
import { deserializeUsageExtra, serializeUsageExtra } from "../../../src/shared/usage-extra.ts";
import {
  createAntigravityAccount,
  listAntigravityAccounts,
  removeAntigravityAccount,
  selectAntigravityAccount,
  setAntigravityAccountStatus,
} from "../../../src/services/antigravity-account.service.ts";
import {
  startAntigravityLogin,
  submitAntigravityLoginCode,
} from "../../../src/services/antigravity-account-login.ts";
import { bindPickedAccount, canBindAccount } from "../../../src/services/picked-account-binding.ts";
import { closeDb, getSessionAccount } from "../../../src/services/db.service.ts";
import { discoverSkillRoots } from "../../../src/services/slash-discovery/discover-skill-roots.ts";
import { buildSharedProviderContext } from "../../../src/services/provider-shared-context.ts";
import type { ChatEvent } from "../../../src/types/chat.ts";

describe("AntigravityProvider & ecosystem integration", () => {
  let tempHome: string;
  let projectDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "ppm-agy-prov-"));
    projectDir = join(tempHome, "workspace", "my-app");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("parses HTTP port from language_server.log", () => {
    const sampleLog = [
      "I1106 16:25:15.251607 1 server.go:746] Language server listening on random port at 45819 for HTTPS (gRPC)",
      "I1106 16:25:15.252230 1 server.go:754] Language server listening on random port at 43607 for HTTP",
    ].join("\n");
    expect(parseHttpPortFromLsLog(sampleLog)).toBe(43607);
  });

  it("parses RetrieveUserQuotaSummary and GetUserStatus into UsageInfo", () => {
    const usage = parseAntigravityUsage(
      {
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-11-07T16:24:51Z" },
                { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.95, resetTime: "2026-11-06T17:14:44Z" },
              ],
            },
            {
              displayName: "Claude and GPT models",
              buckets: [
                { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5, resetTime: "2026-11-13T07:16:43Z" },
                { bucketId: "3p-5h", window: "5h", remainingFraction: 1.0, resetTime: "2026-11-06T18:56:53Z" },
              ],
            },
          ],
        },
      },
      {
        userStatus: {
          name: "shopee 1",
          email: "user@example.com",
          userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
          planStatus: { planInfo: { planName: "Pro" } },
        },
      },
    );

    expect(usage.fiveHour).toBeCloseTo(0.05, 5);
    expect(usage.sevenDay).toBeCloseTo(0.2, 5);
    expect(usage.activeAccountLabel).toBe("shopee 1 · Google AI Ultra");
    expect(usage.activeAccountId).toBe("user@example.com");
    expect(usage.weeklyScoped).toHaveLength(2);
    expect(usage.weeklyScoped?.[0]?.label).toBe("Claude and GPT models · Weekly");
    expect(usage.weeklyScoped?.[0]?.utilization).toBeCloseTo(0.5, 5);
  });

  it("1.5: managed language_server discovery reads hub_*.json as well as ls_*.json, and handles spawn errors", async () => {
    const {
      discoverDaemonConnection,
      ensureLanguageServerConnection,
    } = await import("../../../src/providers/antigravity/antigravity-connection.ts");

    // (a) discoverDaemonConnection reads hub_*.json in addition to ls_*.json
    const hubHome = join(tempHome, "hub-home");
    const hubDaemonDir = join(hubHome, ".gemini", "antigravity", "daemon");
    mkdirSync(hubDaemonDir, { recursive: true });
    writeFileSync(
      join(hubDaemonDir, "hub_99.json"),
      JSON.stringify({ pid: process.pid, httpPort: 54321, csrfToken: "hub-csrf-token" }),
      "utf-8",
    );
    const hubConn = discoverDaemonConnection(hubHome);
    expect(hubConn).toEqual({ address: "127.0.0.1:54321", csrfToken: "hub-csrf-token" });

    // (b) spawn error (e.g. non-executable binary EACCES) is caught via proc.on("error") and returns null instead of crashing
    const errHome = join(tempHome, "err-home");
    mkdirSync(join(errHome, ".gemini"), { recursive: true });
    writeFileSync(join(errHome, ".gemini", "jetski-standalone-oauth-token"), "tok", "utf-8");
    const nonExecBin = join(errHome, "bad_ls_bin");
    writeFileSync(nonExecBin, "not executable", { mode: 0o644 });

    const prevLsBin = process.env.ANTIGRAVITY_LS_BIN;
    process.env.ANTIGRAVITY_LS_BIN = nonExecBin;
    try {
      const conn = await ensureLanguageServerConnection(errHome);
      expect(conn).toBeNull();
    } finally {
      if (prevLsBin === undefined) delete process.env.ANTIGRAVITY_LS_BIN;
      else process.env.ANTIGRAVITY_LS_BIN = prevLsBin;
    }

  });

  it("1.6: keeps session streaming in useStreamingStore and ws/chat across session_migrated -> system(init) -> text", async () => {
    const { chatWebSocket } = await import("../../../src/server/ws/chat.ts");
    const { providerRegistry } = await import("../../../src/providers/registry.ts");
    const { useStreamingStore } = await import("../../../src/web/stores/streaming-store.ts");
    const { globalWebSocket } = await import("../../../src/server/ws/global.ts");

    useStreamingStore.setState({ sessions: new Map() });

    const oldId = "draft-16-old";
    const newId = "88888888-aaaa-4bbb-8ccc-888888888888";
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => { releaseTurn = r; });

    const migProviderId = "dummy-migrating-provider";
    providerRegistry.register({
      id: migProviderId,
      name: "Dummy Migrating",
      async createSession(cfg) {
        return { id: oldId, providerId: migProviderId, title: cfg.title ?? "Test", createdAt: new Date().toISOString() };
      },
      async resumeSession(id) {
        return { id, providerId: migProviderId, title: "Test", createdAt: new Date().toISOString() };
      },
      async listSessions() { return []; },
      async deleteSession() {},
      async *sendMessage() {
        yield { type: "session_migrated", oldSessionId: oldId, newSessionId: newId } as ChatEvent;
        yield { type: "system", subtype: "init" } as ChatEvent;
        yield { type: "text", content: "Hello after migration" } as ChatEvent;
        await turnGate;
        yield { type: "done", sessionId: newId, resultSubtype: "success" } as ChatEvent;
      },
    });

    const globalWsMock: any = {
      data: { type: "global" },
      send(raw: string) {
        const ev = JSON.parse(raw);
        if (ev.type === "session:phase_changed") {
          useStreamingStore.getState().setStreaming(ev.sessionId, ev.phase !== "idle", ev.projectName);
        } else if (ev.type === "session:migrated") {
          const st = useStreamingStore.getState() as any;
          if (typeof st.migrateSession === "function") {
            st.migrateSession(ev.oldSessionId, ev.newSessionId, ev.projectName);
          } else {
            st.dropSession(ev.oldSessionId);
          }
        }
        return raw.length;
      },
    };
    globalWebSocket.open(globalWsMock);

    try {
      const sentPayloads: any[] = [];
      const wsMock: any = {
        data: { type: "chat", sessionId: oldId, providerHint: migProviderId },
        send(raw: string) {
          sentPayloads.push(JSON.parse(raw));
        },
      };

      chatWebSocket.open(wsMock);
      await chatWebSocket.message(wsMock, JSON.stringify({ type: "message", content: "Start new chat" }));

      for (let i = 0; i < 40; i++) {
        if (sentPayloads.some((p) => p.type === "text")) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // While streaming text after session_migrated, newId MUST be in useStreamingStore.sessions
      // and oldId MUST NOT remain dangling in useStreamingStore.sessions
      const activeMap = useStreamingStore.getState().sessions;
      expect(activeMap.has(oldId)).toBe(false);
      expect(activeMap.has(newId)).toBe(true);

      releaseTurn();
      await new Promise((r) => setTimeout(r, 30));
      expect(useStreamingStore.getState().sessions.has(newId)).toBe(false);
    } finally {
      globalWebSocket.close(globalWsMock);
    }
  });

  it("2.1: tags .agents/skills and ~/.gemini/.../skills with dedicated sources and hides them from claude while exposing them to antigravity", async () => {
    const { listSlashItems, invalidateAll } = await import("../../../src/services/slash-discovery/index.ts");
    const { listSlashItemsForProvider } = await import("../../../src/services/slash-items-for-provider.ts");

    const proj21 = join(tempHome, "proj-21");
    mkdirSync(join(proj21, ".git"), { recursive: true });
    mkdirSync(join(proj21, ".agents", "skills", "foo-agy-skill"), { recursive: true });
    writeFileSync(
      join(proj21, ".agents", "skills", "foo-agy-skill", "SKILL.md"),
      "---\nname: foo-agy-skill\ndescription: Antigravity skill\n---\nBody\n",
      "utf-8",
    );
    mkdirSync(join(proj21, ".claude", "skills", "bar-claude-skill"), { recursive: true });
    writeFileSync(
      join(proj21, ".claude", "skills", "bar-claude-skill", "SKILL.md"),
      "---\nname: bar-claude-skill\ndescription: Claude skill\n---\nBody\n",
      "utf-8",
    );
    mkdirSync(join(tempHome, ".gemini", "antigravity", "builtin", "skills", "agy-customizations"), { recursive: true });
    writeFileSync(
      join(tempHome, ".gemini", "antigravity", "builtin", "skills", "agy-customizations", "SKILL.md"),
      "---\nname: agy-customizations\ndescription: Builtin AGY skill\n---\nBody\n",
      "utf-8",
    );

    const prevHome = process.env.HOME;
    process.env.HOME = tempHome;
    invalidateAll();
    try {
      const rootsAll = discoverSkillRoots(proj21);
      const agentsRoot = rootsAll.find((r) => r.path.endsWith(".agents/skills"));
      const geminiRoot = rootsAll.find((r) => r.path.includes(".gemini/antigravity"));
      expect(agentsRoot?.source).toBe("project-agents" as any);
      expect(geminiRoot?.source).toBe("user-antigravity" as any);

      const claudeItems = await listSlashItemsForProvider(proj21, "claude", undefined);
      const claudeNames = claudeItems.map((i) => i.name);
      expect(claudeNames).toContain("bar-claude-skill");
      expect(claudeNames).not.toContain("foo-agy-skill");
      expect(claudeNames).not.toContain("agy-customizations");

      const agyItems = await listSlashItemsForProvider(proj21, "antigravity", undefined);
      const agyNames = agyItems.map((i) => i.name);
      expect(agyNames).toContain("foo-agy-skill");
      expect(agyNames).toContain("agy-customizations");

      const directClaude = (listSlashItems as any)(proj21, "claude") as Array<{ name: string }>;
      expect(directClaude.map((i) => i.name)).not.toContain("foo-agy-skill");
      const directAgy = (listSlashItems as any)(proj21, "antigravity") as Array<{ name: string }>;
      expect(directAgy.map((i) => i.name)).toContain("foo-agy-skill");
    } finally {
      process.env.HOME = prevHome;
      invalidateAll();
    }
  });

  it("2.2: buildSharedProviderContext does not re-inject Antigravity native rules into antigravity recipient and does not starve ~/.codex/AGENTS.md when .agents/rules is large", async () => {
    const proj22 = join(tempHome, "proj-22");
    mkdirSync(join(proj22, ".agents", "rules"), { recursive: true });
    writeFileSync(join(proj22, "GEMINI.md"), "NATIVE_GEMINI_MD_CONTENT", "utf-8");
    writeFileSync(join(proj22, "CLAUDE.md"), "SHARED_CLAUDE_MD_CONTENT", "utf-8");
    // 5 files x 2.5 KB in .agents/rules + large knowledge files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(proj22, ".agents", "rules", `rule-${i}.md`), `AGY_RULE_${i} ` + "x".repeat(2500), "utf-8");
    }
    const knowledgeDir = join(tempHome, ".gemini", "antigravity", "knowledge", "topic-a");
    mkdirSync(knowledgeDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(knowledgeDir, `kb-${i}.md`), `AGY_KB_BODY_${i} ` + "y".repeat(3000), "utf-8");
    }

    const codexHome = join(tempHome, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "IMPORTANT_CODEX_AGENTS_MD_INSTRUCTION", "utf-8");

    const provider = new AntigravityProvider({ customHome: tempHome });

    // (a) When recipientProviderId === "antigravity", native GEMINI.md, .agents/rules, and knowledge are NOT duplicated
    const ctxForAgy = await buildSharedProviderContext(proj22, [provider], {
      userHome: tempHome,
      codexHomes: [codexHome],
      recipientProviderId: "antigravity",
    });
    expect(ctxForAgy).toContain("SHARED_CLAUDE_MD_CONTENT");
    expect(ctxForAgy).not.toContain("NATIVE_GEMINI_MD_CONTENT");
    expect(ctxForAgy).not.toContain("AGY_RULE_0");
    expect(ctxForAgy).not.toContain("AGY_KB_BODY_0");

    // (b) When recipientProviderId === "claude", ~/.codex/AGENTS.md is NOT starved by .agents/rules or knowledge
    const ctxForClaude = await buildSharedProviderContext(proj22, [provider], {
      userHome: tempHome,
      codexHomes: [codexHome],
      recipientProviderId: "claude",
    });
    expect(ctxForClaude).toContain("IMPORTANT_CODEX_AGENTS_MD_INSTRUCTION");
    expect(ctxForClaude).not.toContain("AGY_KB_BODY_0");
  });

  it("discovers .agents/skills in project and shares GEMINI.md / .agents/rules context", async () => {
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".agents", "skills", "my-skill"), { recursive: true });
    mkdirSync(join(projectDir, ".agents", "rules"), { recursive: true });
    writeFileSync(join(projectDir, "GEMINI.md"), "# Gemini Project Rules\nAlways use strict mode.", "utf-8");
    writeFileSync(join(projectDir, ".agents", "rules", "style.md"), "Keep files under 200 lines.", "utf-8");

    const roots = discoverSkillRoots(projectDir);
    expect(roots.some((r) => r.path.endsWith(".agents/skills"))).toBe(true);

    const provider = new AntigravityProvider({ customHome: tempHome });
    const ctxForClaude = await buildSharedProviderContext(projectDir, [provider], {
      userHome: tempHome,
      codexHomes: [],
      recipientProviderId: "claude",
    });
    expect(ctxForClaude).toContain("Gemini Project Rules");
    expect(ctxForClaude).toContain("Keep files under 200 lines.");
  });

  it("parses GetCascadeModelConfigData into deduplicated base models and resolves model + effort", async () => {
    const parsed = parseAntigravityModels({
      clientModelConfigs: [
        { label: "Claude Opus 5.5 (High)", modelId: "claude-opus-5-5-high" },
        { label: "Gemini 4 Argon (Medium)", modelId: "gemini-4-argon-medium" },
        { label: "Gemini 4 Argon (High)", modelId: "gemini-4-argon-high" },
        { label: "GPT-OSS 120B (Medium)", modelId: "gpt-oss-120b-medium" },
      ],
      clientModelSorts: [
        {
          name: "Recommended",
          groups: [{ modelLabels: ["Gemini 4 Argon (Medium)", "Gemini 4 Argon (High)", "Claude Opus 5.5 (High)", "GPT-OSS 120B (Medium)"] }],
        },
      ],
    });
    expect(parsed).toEqual([
      { value: "gemini-4-argon", label: "Gemini 4 Argon" },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B" },
    ]);
    expect(ANTIGRAVITY_FALLBACK_MODELS.length).toBe(5);
    expect(resolveAntigravityModelId("gemini-4-argon", "low")).toBe("gemini-4-argon-low");
    expect(resolveAntigravityModelId("gemini-4-argon", "medium")).toBe("gemini-4-argon-medium");
    expect(resolveAntigravityModelId("gemini-4-argon", "high")).toBe("gemini-4-argon-high");
    expect(resolveAntigravityModelId("gpt-oss-120b", "high")).toBe("gpt-oss-120b-medium");

    const usage = parseAntigravityUsage(
      { fiveHourRemainingFraction: 0.98, sevenDayRemainingFraction: 0.81 },
      { userStatus: { name: "shopee 1", email: "user@example.com", planStatus: { planInfo: { planName: "Pro" } } } },
    );
    const json = serializeUsageExtra(usage);
    const restored = deserializeUsageExtra(json);
    expect(restored.activeAccountLabel).toBe("shopee 1 · Pro");
    expect(restored.activeAccountId).toBe("user@example.com");
  });

  it("manages multiple Antigravity accounts, PKCE OAuth login, rotation, and session binding", async () => {
    const prevPpmHome = process.env.PPM_HOME;
    process.env.PPM_HOME = join(tempHome, "ppm-home");
    closeDb();

    try {
      const a1 = createAntigravityAccount({
        id: "default",
        label: "shopee 1",
        email: "user@example.com",
        planType: "Pro",
        home: "",
      });
      expect(a1.id).toBe("default");
      expect(a1.home).toBe("");

      let submittedCode = "";
      const loginStart = await startAntigravityLogin("Work Account", undefined, {
        spawnLogin: async (home) => ({
          authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz",
          handle: {
            writeCode(codeOrUrl: string) {
              submittedCode = codeOrUrl;
              mkdirSync(join(home, ".gemini"), { recursive: true });
              writeFileSync(join(home, ".gemini", "jetski-standalone-oauth-token"), '{"access_token":"tok"}', "utf-8");
            },
            async waitForExit() {
              return { code: 0, output: "Authenticated!" };
            },
            kill() {},
          },
        }),
        verifyHome: async () => ({
          connected: true,
          name: "Work Team",
          email: "work@company.com",
          planName: "Google AI Ultra",
          usage: { fiveHour: 0.12, sevenDay: 0.25 },
        }),
      });

      expect(loginStart.authUrl).toContain("https://accounts.google.com/o/oauth2/auth");
      const status = await submitAntigravityLoginCode(loginStart.id, "4/0A-auth-code-123");
      expect(submittedCode).toBe("4/0A-auth-code-123");
      expect(status.state).toBe("done");
      if (status.state !== "done") throw new Error("Expected done");
      expect(status.account.label).toBe("Work Account");
      expect(status.account.email).toBe("work@company.com");
      expect(status.account.planType).toBe("Google AI Ultra");

      const all = listAntigravityAccounts();
      expect(all.map((a) => a.id)).toEqual(["default", status.account.id]);

      // Lowest-usage selection & 5h cap skip
      const pickedLowest = selectAntigravityAccount({
        strategy: "lowest-usage",
        usageOf: (id) => (id === "default" ? 0.8 : 0.12),
      });
      expect(pickedLowest?.id).toBe(status.account.id);

      // Session binding
      expect(canBindAccount("antigravity", status.account.id)).toBe(true);
      expect(bindPickedAccount("sess-agy-1", "antigravity", status.account.id)).toBe(true);
      expect(getSessionAccount("sess-agy-1")).toBe(status.account.id);

      // Disable & remove
      setAntigravityAccountStatus(status.account.id, "disabled");
      expect(canBindAccount("antigravity", status.account.id)).toBe(false);
      removeAntigravityAccount(status.account.id);
      expect(listAntigravityAccounts()).toHaveLength(1);
    } finally {
      closeDb();
      if (prevPpmHome === undefined) delete process.env.PPM_HOME;
      else process.env.PPM_HOME = prevPpmHome;
    }
  });

  it("3.4: registers antigravityUsageSource at startup, skips auth-failed accounts in rotation, rejects relogin on default account, clears timer during submit, and truncates long agy errors", async () => {
    const prevPpmHome = process.env.PPM_HOME;
    process.env.PPM_HOME = join(tempHome, "ppm-home-34");
    closeDb();

    try {
      const { _clearUsageSources, getUsageSource } = await import(
        "../../../src/services/provider-usage/usage-registry.ts"
      );
      const { registerAllUsageSources } = await import(
        "../../../src/services/provider-usage/register-usage-sources.ts"
      );
      _clearUsageSources();
      registerAllUsageSources();
      expect(getUsageSource("antigravity")).toBeDefined();

      for (const existing of listAntigravityAccounts()) {
        removeAntigravityAccount(existing.id);
      }

      // Create default + two isolated accounts
      createAntigravityAccount({
        id: "default",
        label: "Default Desktop",
        email: "desktop@example.com",
        home: "",
      });
      const acct1 = createAntigravityAccount({
        id: "acct-34-1",
        label: "Acct 1",
        email: "a1@example.com",
      });
      const acct2 = createAntigravityAccount({
        id: "acct-34-2",
        label: "Acct 2",
        email: "a2@example.com",
      });

      // (a) Reject relogin on "default" account (empty home)
      let defaultErr = "";
      try {
        await startAntigravityLogin("Default", "default");
      } catch (e) {
        defaultErr = (e as Error).message;
      }
      expect(defaultErr).toMatch(/default|ambient|cannot/i);

      // (b) Auth-failed account is skipped by selectAntigravityAccount
      const acctSvc = (await import("../../../src/services/antigravity-account.service.ts")) as Record<string, any>;
      expect(typeof acctSvc.markAntigravityAccountAuthFailed).toBe("function");
      acctSvc.markAntigravityAccountAuthFailed("default", "signed out");
      acctSvc.markAntigravityAccountAuthFailed(acct1.id, "signed out");
      const picked = selectAntigravityAccount({ strategy: "round-robin" });
      expect(picked?.id).toBe(acct2.id);

      // (c) Truncate long agy error output on failed login code exchange
      const longErrorFlow = await startAntigravityLogin("LongErr", undefined, {
        spawnLogin: async () => ({
          authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
          handle: {
            writeCode() {},
            async waitForExit() {
              return {
                code: 1,
                output: "Couldn't sign in: " + "E".repeat(600),
              };
            },
            kill() {},
          },
        }),
      });
      const errStatus = await submitAntigravityLoginCode(longErrorFlow.id, "bad-code");
      expect(errStatus.state).toBe("error");
      if (errStatus.state === "error") {
        expect(errStatus.error.length).toBeLessThanOrEqual(240);
      }
    } finally {
      closeDb();
      if (prevPpmHome === undefined) delete process.env.PPM_HOME;
      else process.env.PPM_HOME = prevPpmHome;
    }
  });

  it("3.5: resolveTargetDir resolves user-scope antigravity skill to ~/.gemini/config/skills/ppm and SKILL.md clarifies PPM_AI_CHAT for Antigravity", async () => {
    const { resolveTargetDir } = await import(
      "../../../src/services/skill-export/resolve-target-dir.ts"
    );
    const { BUNDLED_SKILL_FILES } = await import(
      "../../../src/services/skill-export/copy-bundled-skill.ts"
    );
    const userTarget = resolveTargetDir({ scope: "user", format: "antigravity" });
    expect(userTarget.replace(/\\/g, "/")).toEndWith("/.gemini/config/skills/ppm");

    const projTarget = resolveTargetDir({ scope: "project", format: "antigravity" });
    expect(projTarget.replace(/\\/g, "/")).toEndWith("/.agents/skills/ppm");

    expect(BUNDLED_SKILL_FILES["SKILL.md"]).toContain("Antigravity");
    expect(BUNDLED_SKILL_FILES["references/cli-reference.md"]).toContain("--format");
    expect(BUNDLED_SKILL_FILES["references/http-api.md"]).toContain("/api/antigravity-accounts");
  });

  it("3.6: sanitizeConfig creates provider-appropriate config entry for codex and antigravity instead of cloning claude agent-sdk config", async () => {
    const { DEFAULT_CONFIG, sanitizeConfig, validateAIProviderConfig } = await import(
      "../../../src/types/config.ts"
    );

    const cfgCodex = structuredClone(DEFAULT_CONFIG);
    cfgCodex.ai.default_provider = "codex";
    delete cfgCodex.ai.providers.codex;
    sanitizeConfig(cfgCodex);
    expect(cfgCodex.ai.providers.codex?.type).toBe("cli");
    expect(cfgCodex.ai.providers.codex?.cli_command).toBe("codex");
    expect(validateAIProviderConfig({ ...cfgCodex.ai.providers.codex, model: "gpt-6-sol" })).toEqual([]);

    const cfgAgy = structuredClone(DEFAULT_CONFIG);
    cfgAgy.ai.default_provider = "antigravity";
    delete cfgAgy.ai.providers.antigravity;
    sanitizeConfig(cfgAgy);
    expect(cfgAgy.ai.providers.antigravity?.type).toBe("cli");
    expect(cfgAgy.ai.providers.antigravity?.cli_command).toBe("agy");
    expect(cfgAgy.ai.providers.antigravity?.model).toBe("gemini-4-argon");
    expect(validateAIProviderConfig({ ...cfgAgy.ai.providers.antigravity, model: "gemini-4-argon" })).toEqual([]);
  });

  it("4.1: transcript parser emits text before tool_use, assigns subagent-<uuid> before emitting tool_use and skips parent sessionId, preserves pendingQueue on cursor resume, and sums token usage", async () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const logsDir = join(tempHome, ".gemini", "antigravity", "brain", parentId, ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    // Step 1: PLANNER_RESPONSE with both text content, tool_calls (read_file + invoke_subagent), and token counts
    const step1 = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      thinking: "Thinking first",
      content: "I will read a file and launch a subagent.",
      input_tokens: 1500,
      cache_read_tokens: 3000,
      output_tokens: 250,
      tool_calls: [
        { id: "call-read-1", name: "read_file", args: { Path: "/tmp/a.txt" } },
        { id: "call-sub-1", name: "invoke_subagent", args: { TypeName: "research", Role: "Scout", Prompt: "Find x" } },
      ],
    });
    // Step 2: GENERIC result for read_file
    const step2 = JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: "file contents",
    });
    // Step 3: GENERIC result for invoke_subagent mentioning parentId BEFORE childId
    const step3 = JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      content: `Parent conversation ${parentId} spawned subagent with conversationId: ${childId}`,
    });
    // Step 4: Final PLANNER_RESPONSE
    const step4 = JSON.stringify({
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "All done.",
      input_tokens: 500,
      cache_read_tokens: 4000,
      output_tokens: 100,
    });

    writeFileSync(
      transcriptFile,
      `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "Init" })}\n`,
      "utf-8",
    );

    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "Init" }),
        step1,
        step2,
        step3,
        step4,
      ].join("\n") + "\n",
      "utf-8",
    );

    const { createAntigravityTailParser } = await import(
      "../../../src/providers/antigravity/antigravity-transcript-parser.ts"
    );
    const parser = createAntigravityTailParser({ parentSessionId: parentId });
    const events: ChatEvent[] = [];
    for (const line of [step1, step2, step3, step4]) {
      for (const { ev } of parser.feed(line).events) events.push(ev);
    }
    for (const { ev } of parser.flushPending()) events.push(ev);

    // (a) Text of step 1 is emitted BEFORE tool_use of step 1
    const textIdx = events.findIndex((e) => e.type === "text" && e.content.includes("I will read a file"));
    const readToolIdx = events.findIndex((e) => e.type === "tool_use" && e.tool === "Read");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(readToolIdx).toBeGreaterThan(textIdx);

    // (b) Subagent tool_use is emitted with toolUseId = subagent-<childId> (skipping parentId!)
    // so both tool_use and tool_result share the exact same subagent-<childId> id in live streaming
    const agentToolUse = events.find((e) => e.type === "tool_use" && e.tool === "Agent") as Extract<
      ChatEvent,
      { type: "tool_use" }
    > | undefined;
    const agentToolResult = events.find(
      (e) => e.type === "tool_result" && e.output.includes("spawned subagent"),
    ) as Extract<ChatEvent, { type: "tool_result" }> | undefined;
    expect(agentToolUse?.toolUseId).toBe(`subagent-${childId}`);
    expect(agentToolResult?.toolUseId).toBe(`subagent-${childId}`);

    // (c) extractSubagentIdsFromTranscript skips parentId and only returns childId
    const { extractSubagentIdsFromTranscript } = await import(
      "../../../src/providers/antigravity/antigravity-history.ts"
    );
    const subIds = extractSubagentIdsFromTranscript(transcriptFile);
    expect(subIds.has(parentId)).toBe(false);
    expect(subIds.has(childId)).toBe(true);

    // (d) Cursor resume in agent-transcript-file-tail-state preserves pendingQueue across step1 -> step2 boundary
    const { createFileTailState } = await import(
      "../../../src/services/agent-transcript/agent-transcript-file-tail-state.ts"
    );
    const { processFileTail } = await import(
      "../../../src/services/agent-transcript/agent-transcript-file-tail-feed.ts"
    );
    const step0 = JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "Init" });
    const offsetAfterStep1 = Buffer.byteLength(`${step0}\n${step1}\n`, "utf-8");
    const tailState = createFileTailState(
      { key: parentId, path: transcriptFile, provider: "antigravity" },
      offsetAfterStep1,
      Date.now(),
    );
    const tailRes = processFileTail(tailState, Date.now());
    const resumedReadResult = tailRes.envelopes.find((env) => env.ev.type === "tool_result");
    expect((resumedReadResult?.ev as Extract<ChatEvent, { type: "tool_result" }> | undefined)?.toolUseId).toBe(
      "call-read-1",
    );

    // (e) Token usage is summed over the PLANNER_RESPONSE steps
    const usage = parser.getTurnUsage();
    expect(usage?.inputTokens).toBe(2000);
    expect(usage?.cacheReadTokens).toBe(7000);
    expect(usage?.outputTokens).toBe(350);
  });
});
