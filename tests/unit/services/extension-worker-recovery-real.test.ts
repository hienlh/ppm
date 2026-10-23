import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { extensionService } from "../../../src/services/extension.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { getExtensionById, insertExtension, deleteExtension } from "../../../src/services/db.service.ts";

/**
 * Recovery driven end to end: a real extension host worker, the real close listener and the
 * real rebuild. Nothing on the service is stubbed; the tests only read its private state to
 * see what the rebuild did.
 */
interface RecoveryState {
  worker: Worker | null;
  recovering: boolean;
  recoveryTimes: number[];
  ensureWorker(): { worker: Worker };
  terminateWorker(): Promise<void>;
}

const svc = extensionService as unknown as RecoveryState;

const BUNDLED_ID = "@ppm/ext-git-graph";
const EXITING_ID = "@probe/exit-on-activate";
const exitingDir = resolve(getPpmDir(), "extensions", "node_modules", "@probe", "exit-on-activate");

function closed(worker: Worker): Promise<void> {
  return new Promise((done) => worker.addEventListener("close", () => done(), { once: true }));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

/** Registers the real bundled git-graph extension the way startup does: discover, then a row. */
async function registerBundledGitGraph(): Promise<void> {
  const manifest = (await extensionService.discover()).find((m) => m.id === BUNDLED_ID);
  if (!manifest) throw new Error(`${BUNDLED_ID} was not discovered under packages/`);
  if (!getExtensionById(BUNDLED_ID)) {
    insertExtension({
      id: BUNDLED_ID, version: manifest.version, display_name: null, description: null,
      icon: null, enabled: 1, manifest: JSON.stringify(manifest),
    });
  }
}

/** A user extension whose activate() ends the host thread, every time it is activated. */
function registerExitingExtension(): void {
  mkdirSync(exitingDir, { recursive: true });
  writeFileSync(resolve(exitingDir, "index.js"), "export function activate() { process.exit(1); }\n");
  const manifest = { id: EXITING_ID, name: EXITING_ID, version: "1.0.0", main: "index.js" };
  insertExtension({
    id: EXITING_ID, version: "1.0.0", display_name: null, description: null,
    icon: null, enabled: 1, manifest: JSON.stringify(manifest),
  });
}

describe("extension host recovery with real workers", () => {
  beforeEach(() => {
    svc.recoveryTimes = [];
  });

  afterEach(async () => {
    await waitFor(() => !svc.recovering, 30_000);
    await svc.terminateWorker();
    deleteExtension(EXITING_ID);
    deleteExtension(BUNDLED_ID);
    rmSync(resolve(getPpmDir(), "extensions", "node_modules", "@probe"), { recursive: true, force: true });
    svc.recoveryTimes = [];
  });

  it("re-activates a bundled extension after the host exits on its own", async () => {
    await registerBundledGitGraph();
    await extensionService.activate(BUNDLED_ID);
    const { worker } = svc.ensureWorker();

    const exited = closed(worker);
    // Ends the thread without going through the service, as an extension's crash does.
    worker.terminate();
    await exited;

    await waitFor(() => !svc.recovering && extensionService.isActivated(BUNDLED_ID), 20_000);
    expect({
      activated: extensionService.isActivated(BUNDLED_ID),
      error: extensionService.getActivationErrors().get(BUNDLED_ID) ?? null,
    }).toEqual({ activated: true, error: null });
    expect(svc.worker).not.toBe(worker);
    expect(svc.recoveryTimes).toHaveLength(1);
    // Still known as bundled, so it still cannot be removed.
    expect(extensionService.isBundled(BUNDLED_ID)).toBe(true);
    await expect(extensionService.remove(BUNDLED_ID)).rejects.toThrow("Cannot remove bundled extension");
  }, 40_000);

  it("counts a host that dies during re-activation and gives up after three rebuilds", async () => {
    registerExitingExtension();
    // The first activation ends the host; every rebuild re-activates it and ends that one too.
    await extensionService.activate(EXITING_ID).catch(() => {});

    const settled = await waitFor(() => !svc.recovering && svc.worker === null, 25_000);
    expect({ settled, rebuilds: svc.recoveryTimes.length }).toEqual({ settled: true, rebuilds: 3 });
    expect(extensionService.isActivated(EXITING_ID)).toBe(false);
  }, 45_000);
});
