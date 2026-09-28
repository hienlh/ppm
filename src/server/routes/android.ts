/**
 * `/api/android/*` — the Android emulator surface.
 *
 * Guard style mirrors `remote-desktop.ts`, and for the same reason: `authMiddleware` passes
 * everything through when PPM auth is disabled, so a feature that spawns processes on the host
 * and hands over control of them must enforce `auth.enabled` itself, plus an Origin check so a
 * foreign page cannot drive it with ambient browser credentials.
 *
 * That Origin check compares **hostname only, not host:port** — deliberately, and copied from
 * `remote-desktop.ts` where the reasoning is spelled out: Vite's dev proxy rewrites `Host`
 * without adding `X-Forwarded-Host`, so a full-host comparison rejects every dev-mode request.
 * It is worth being clear about what that costs: a page on a *different port* of the same
 * hostname is not rejected. It is not a complete same-origin guarantee, and the nonce that
 * Phase 2's WS session requires is what actually gates control.
 *
 * Anything that can take minutes (a cold boot) answers with an operation id rather than holding
 * the request open — see `android-operations.ts`.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { isAndroidEmulatorEnabled } from "../../services/android/android-flag.ts";
import { androidCapabilities } from "../../services/android/android-capabilities.ts";
import { discoverSdk } from "../../services/android/sdk-discovery.ts";
import { listDevices, releaseOwnership } from "../../services/android/device-registry.ts";
import { EmulatorLimitError, emulatorLog, startEmulator, stopEmulator } from "../../services/android/emulator-launcher.ts";
import { getOperation } from "../../services/android/android-operations.ts";
import { mintAndroidNonce } from "../../services/android/android-nonce.ts";
import { listAvds } from "../../services/android/avd-list.ts";
import { abiMatchesHost, listSystemImages } from "../../services/android/system-images.ts";
import {
  createAvd, deleteAvd, listDeviceProfiles, validateAvdName, wipeAvdData, type CreateAvdRequest,
} from "../../services/android/avd-manager.ts";
import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { findRunningByDeviceId, type DeviceEntry } from "../../services/android/device-registry.ts";
import type { RunningEmulator } from "../../services/android/emulator-discovery.ts";
import { connectToEmulator, getEmulatorStatus, type EmulatorChannel } from "../../services/android/android-grpc.ts";
import { getClipboard } from "../../services/android/android-input.ts";
import { MAX_CLIPBOARD_CHARS, screenshotFilename, setDeviceClipboard, takeScreenshot } from "../../services/android/android-screenshot.ts";
import { findProjectApks, installApk, stageApkUpload } from "../../services/android/android-apk.ts";
import { cancelOperation, createOperation, failOperation, finishOperation, registerCanceller, updateOperation } from "../../services/android/android-operations.ts";

export const androidRoutes = new Hono();

function androidConfig() {
  return configService.get("android") ?? {};
}

/** Disabled-feature check only. Read-only diagnostics may pass this and nothing more. */
function assertEnabled(c: Context): Response | null {
  if (!isAndroidEmulatorEnabled()) {
    return c.json(err("android emulator support is disabled on this host (set ANDROID_EMULATOR_ENABLED=1)"), 404);
  }
  return null;
}

/** Full guard for anything that acts on the host. */
function assertControlAllowed(c: Context): Response | null {
  const disabled = assertEnabled(c);
  if (disabled) return disabled;
  if (!configService.get("auth").enabled) {
    return c.json(err("android emulator control requires PPM authentication to be enabled"), 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).hostname; } catch { originHost = null; }
    let requestHost: string | null = null;
    try { requestHost = new URL(c.req.url).hostname; } catch { requestHost = null; }
    if (!originHost || !requestHost || originHost !== requestHost) {
      return c.json(err("cross-origin request rejected"), 403);
    }
  }
  return null;
}

/** Where AVDs live for this host, resolved once per request rather than cached: a user can
 *  change the SDK path in Settings and the next call must see it. */
async function avdHome(): Promise<string> {
  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  return sdk.avdHome;
}

androidRoutes.get("/capabilities", async (c) => {
  // Deliberately answerable while disabled: `enabled` is how the nav decides whether to show the
  // entry at all, and the device list's requirement rows say why it is off.
  const caps = await androidCapabilities({
    enabled: isAndroidEmulatorEnabled(),
    configuredSdkRoot: androidConfig().sdk_root ?? null,
  });
  return c.json(ok({
    ...caps,
    authRequired: configService.get("auth").enabled,
    // Whether the device list may offer "New device" at all: creating one is `avdmanager`, which
    // ships with the command-line tools and is the one SDK piece an emulator install can lack.
    canCreateAvd: !!caps.sdk.avdmanager.path,
  }));
});

androidRoutes.get("/devices", async (c) => {
  const rejected = assertEnabled(c);
  if (rejected) return rejected;
  const devices = listDevices(await avdHome());
  // `runtime.grpcPort` and pid stay server-side: the browser never dials the emulator itself.
  return c.json(ok({
    devices: devices.map((d) => ({
      ...d,
      runtime: d.runtime
        ? {
            deviceId: d.runtime.deviceId,
            generation: d.runtime.generation,
            adbSerial: d.runtime.adbSerial,
            ownedByPpm: d.runtime.ownedByPpm,
          }
        : null,
    })),
  }));
});

androidRoutes.post("/avds/:avdId/start", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const home = await avdHome();
  const device = listDevices(home).find((d) => d.avdId === c.req.param("avdId"));
  if (!device) return c.json(err("no such AVD"), 404);
  if (device.lockedByAnotherProcess) {
    // Plan §5: report the lock, never delete it to force a start.
    return c.json(err(`${device.name} is locked by another process — it is probably open in Android Studio`), 409);
  }

  const cfg = androidConfig();
  const sdk = await discoverSdk(cfg.sdk_root ?? null);
  if (!sdk.emulator.path) return c.json(err("no emulator binary found in the Android SDK"), 400);

  let operation: ReturnType<typeof startEmulator>;
  try {
    operation = startEmulator({
      avdName: device.name,
      avdHome: home,
      emulatorPath: sdk.emulator.path,
      windowMode: cfg.window_mode ?? "no-window",
      gpuMode: cfg.gpu_mode,
      // The launcher counts, not this handler: an await between a count here and the start
      // would let a concurrent request for another AVD take the same slot.
      maxConcurrent: cfg.max_concurrent ?? 1,
    });
  } catch (e) {
    if (e instanceof EmulatorLimitError) return c.json(err(e.message), 409);
    throw e;
  }
  return c.json(ok({ operationId: operation.id, state: operation.state, detail: operation.detail }));
});

androidRoutes.get("/operations/:id", (c) => {
  const rejected = assertEnabled(c);
  if (rejected) return rejected;
  const op = getOperation(c.req.param("id"));
  if (!op) return c.json(err("no such operation"), 404);
  return c.json(ok({
    id: op.id, kind: op.kind, state: op.state, detail: op.detail,
    startedAt: op.startedAt, endedAt: op.endedAt,
    result: op.result, error: op.error,
  }));
});

androidRoutes.post("/devices/:deviceId/stop", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const home = await avdHome();
  const device = listDevices(home).find((d) => d.runtime?.deviceId === c.req.param("deviceId"));
  if (!device?.runtime) return c.json(err("no such running device"), 404);

  // Generation check: a stop issued against a device that has since restarted must not take
  // down the new run. The client sends the generation it last saw.
  const claimed = Number(c.req.query("generation"));
  if (Number.isInteger(claimed) && claimed !== device.runtime.generation) {
    return c.json(err("this device has restarted since you last saw it; refresh and try again"), 409);
  }
  if (!device.runtime.ownedByPpm) {
    return c.json(err(`${device.name} was not started by PPM — disconnect instead of stopping it`), 403);
  }

  const outcome = await stopEmulator(device.name, { avdHome: home });
  if (outcome === "not-owned") {
    return c.json(err(`${device.name} was not started by PPM — disconnect instead of stopping it`), 403);
  }
  return c.json(ok({ outcome }));
});

androidRoutes.get("/devices/:deviceId/log", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;
  const device = listDevices(await avdHome()).find((d) => d.runtime?.deviceId === c.req.param("deviceId"));
  if (!device) return c.json(err("no such running device"), 404);
  return c.json(ok({ lines: emulatorLog(device.name) }));
});

/**
 * Mint the single-use nonce `/ws/android` requires as its first message.
 *
 * The device is named **here**, not on the WS URL, so the thing that decides which VM a socket
 * drives never lands in a proxy or tunnel access log the way `?token=` does.
 */
androidRoutes.post("/devices/:deviceId/sessions", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const deviceId = c.req.param("deviceId");
  const device = listDevices(await avdHome()).find((d) => d.runtime?.deviceId === deviceId);
  if (!device?.runtime) return c.json(err("no such running device"), 404);

  return c.json(ok({
    nonce: mintAndroidNonce(deviceId),
    deviceId,
    generation: device.runtime.generation,
    hardwareKeyboard: device.hardwareKeyboard,
  }));
});

/* =============================================================================================
 * Phase 3 — app tooling: install an APK, take a screenshot, read the log.
 *
 * Every one of these is a *typed* endpoint. There is no route here that takes a command, an adb
 * argument or an RPC name from the browser (plan Phase 3: "API typed riêng, không mở generic
 * shell/RPC proxy"), and each names its device explicitly so a host running two emulators can
 * never install to the wrong one.
 * ============================================================================================= */

/**
 * The one place a deviceId becomes a live gRPC channel, so every caller closes it the same way.
 *
 * A wedged emulator makes the RPC reject, and an unhandled rejection here is a bare 500 with
 * nothing in it — so the failure is turned into the same `{ok:false, error}` shape every other
 * route answers with, carrying gRPC's own words rather than "internal error".
 */
type DeviceOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "no-device" }
  | { kind: "failed"; message: string };

async function withDevice<T>(
  deviceId: string,
  fn: (ctx: { emulator: RunningEmulator; device: DeviceEntry; channel: EmulatorChannel }) => Promise<T>,
): Promise<DeviceOutcome<T>> {
  const device = listDevices(await avdHome()).find((d) => d.runtime?.deviceId === deviceId);
  const emulator = findRunningByDeviceId(deviceId);
  if (!device?.runtime || !emulator) return { kind: "no-device" };
  const channel = connectToEmulator(emulator);
  try {
    return { kind: "ok", value: await fn({ emulator, device, channel }) };
  } catch (e) {
    const err = e as { details?: string; message?: string };
    return { kind: "failed", message: err.details || err.message || "the emulator did not answer" };
  } finally {
    channel.close();
  }
}

/** Every device route answers a failure the same way, so none of them can forget one. */
function deviceProblem(c: Context, outcome: { kind: "no-device" } | { kind: "failed"; message: string }): Response {
  if (outcome.kind === "no-device") return c.json(err("no such running device"), 404);
  return c.json(err(outcome.message), 502);
}

androidRoutes.get("/devices/:deviceId/screenshot", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const outcome = await withDevice(c.req.param("deviceId"), async ({ device, channel }) => {
    const shot = await takeScreenshot(channel);
    return { shot, name: screenshotFilename(device.name) };
  });
  if (outcome.kind !== "ok") return deviceProblem(c, outcome);
  const { shot, name } = outcome.value;

  return new Response(shot.png as unknown as BodyInit, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(shot.png.length),
      // `attachment` so the browser saves it rather than replacing the tab with the image.
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Android-Screenshot-Size": `${shot.width}x${shot.height}`,
    },
  });
});

androidRoutes.get("/devices/:deviceId/clipboard", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;
  const outcome = await withDevice(c.req.param("deviceId"), ({ channel }) => getClipboard(channel));
  if (outcome.kind !== "ok") return deviceProblem(c, outcome);
  return c.json(ok({ text: outcome.value }));
});

androidRoutes.post("/devices/:deviceId/clipboard", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  if (typeof body?.text !== "string") return c.json(err("text is required"), 400);
  if (body.text.length > MAX_CLIPBOARD_CHARS) return c.json(err("that text is too long for the clipboard"), 413);

  // Never log the text: plan Phase 3 gate, "không log nội dung input/clipboard".
  const outcome = await withDevice(c.req.param("deviceId"), async ({ channel }) => {
    await setDeviceClipboard(channel, body.text as string);
    return true;
  });
  if (outcome.kind !== "ok") return deviceProblem(c, outcome);
  return c.json(ok({ set: true }));
});

androidRoutes.post("/operations/:id/cancel", (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;
  const op = getOperation(c.req.param("id"));
  if (!op) return c.json(err("no such operation"), 404);
  if (!cancelOperation(op.id)) {
    return c.json(err(op.endedAt !== null ? "that operation has already finished" : "that operation cannot be cancelled"), 409);
  }
  return c.json(ok({ cancelled: true }));
});

/**
 * Begin an install and return an operation id.
 *
 * Shared by both entry points because everything after "there is a file on this host" is the
 * same; they differ only in where the file came from and whether it is ours to delete.
 */
async function beginInstall(
  deviceId: string,
  apkPath: string,
  label: string,
  opts: { reinstall: boolean; allowDowngrade: boolean; cleanup?: () => void },
): Promise<{ operationId: string } | { error: string; status: 400 | 404 }> {
  const device = listDevices(await avdHome()).find((d) => d.runtime?.deviceId === deviceId);
  if (!device?.runtime) return { error: "no such running device", status: 404 };

  // Plan §6: "install APK chỉ khi guest ready". Video is available before the guest has finished
  // booting, so a tab can be perfectly alive while `pm` is not yet running — an install then
  // fails with adb's own wording instead of a sentence that says to wait.
  //
  // `DeviceEntry.state` cannot answer this: `listDevices` is synchronous and sets `ready` for
  // anything with a live process, so it never reports `booting` at all (a Phase 1 gap, noted in
  // the Phase 3 report). `getStatus().booted` is the emulator's own answer, and costs one RPC.
  const emulator = findRunningByDeviceId(deviceId);
  if (emulator) {
    const channel = connectToEmulator(emulator);
    try {
      const status = await getEmulatorStatus(channel);
      if (!status.booted) {
        return { error: `${device.name} has not finished booting — wait for Android to start`, status: 400 };
      }
    } catch {
      // A channel that will not answer is not a reason to refuse: adb may well still work, and
      // its own error is more specific than anything that could be invented here.
    } finally {
      channel.close();
    }
  }

  const serial = device.runtime.adbSerial;
  if (!serial) {
    return { error: `${device.name} has no adb serial yet — wait for it to finish booting`, status: 400 };
  }
  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  if (!sdk.adb.path) return { error: "no adb found; install the Android SDK platform-tools", status: 400 };

  const op = createOperation<{ message: string; code: string | null; package: string | null }>(
    "android-install", `installing ${label} on ${device.name}`);
  const controller = new AbortController();
  registerCanceller(op.id, () => controller.abort());
  updateOperation(op.id, { state: "running" });

  void (async () => {
    try {
      const result = await installApk({
        adbPath: sdk.adb.path!,
        serial,
        apkPath,
        reinstall: opts.reinstall,
        allowDowngrade: opts.allowDowngrade,
        signal: controller.signal,
        // adb's own progress lines ("Performing Streamed Install") are the only honest progress
        // it offers; there is no percentage to report.
        onProgress: (line) => updateOperation(op.id, { detail: line }),
      });
      if (result.ok) finishOperation(op.id, { message: result.message, code: null, package: null });
      else failOperation(op.id, result.message);
    } catch (e) {
      failOperation(op.id, (e as Error).message);
    } finally {
      opts.cleanup?.();
    }
  })();

  return { operationId: op.id };
}

/**
 * Upload an APK and install it.
 *
 * The body is the file itself rather than a multipart form: `Bun.readableStreamToBlob` on a form
 * would buffer the whole upload in memory before a byte reached disk, and these are hundreds of
 * megabytes. Streaming it also makes cancel real — an aborted request rejects the read mid-file
 * and `stageApkUpload` deletes the partial, which is the Phase 3 gate.
 */
androidRoutes.post("/devices/:deviceId/apk", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const deviceId = c.req.param("deviceId");
  if (!listDevices(await avdHome()).some((d) => d.runtime?.deviceId === deviceId)) {
    return c.json(err("no such running device"), 404);
  }
  const body = c.req.raw.body;
  if (!body) return c.json(err("no file in the request body"), 400);

  let staged;
  try {
    staged = await stageApkUpload(body, { signal: c.req.raw.signal });
  } catch (e) {
    // An abort is the client's own doing: the partial is already deleted and there is usually
    // nobody left to read the answer, so this is only a 400 for the case that is not an abort.
    return c.json(err((e as Error).message), 400);
  }

  const filename = (c.req.query("filename") ?? "app.apk").split(/[\\/]/).pop() || "app.apk";
  const started = await beginInstall(deviceId, staged.path, filename, {
    reinstall: c.req.query("reinstall") !== "0",
    allowDowngrade: c.req.query("downgrade") === "1",
    cleanup: () => staged.discard(),
  });
  if ("error" in started) { staged.discard(); return c.json(err(started.error), started.status); }
  return c.json(ok({ ...started, bytes: staged.bytes, filename }));
});

/**
 * Install a file that is already on this host, named by project rather than by path.
 *
 * The path is resolved *inside* the named project and rejected if it escapes — the same rule
 * `extension-rpc-handlers.ts` applies, and the reason this takes `{project, path}` rather than
 * an absolute path: an absolute path would make this route an arbitrary-file reader.
 */
androidRoutes.post("/devices/:deviceId/apk/project", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const body = await c.req.json().catch(() => null) as { project?: unknown; path?: unknown; downgrade?: unknown } | null;
  if (typeof body?.project !== "string" || typeof body?.path !== "string") {
    return c.json(err("project and path are required"), 400);
  }
  const project = configService.get("projects").find((p) => p.name === body.project);
  if (!project) return c.json(err("no such project"), 404);

  const root = resolve(project.path);
  const target = resolve(root, body.path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return c.json(err("that path is outside the project"), 400);
  if (!target.toLowerCase().endsWith(".apk")) return c.json(err("that is not an .apk file"), 400);
  if (!existsSync(target)) return c.json(err("no such file"), 404);

  const started = await beginInstall(c.req.param("deviceId"), target, basename(target), {
    reinstall: true,
    allowDowngrade: body.downgrade === true,
    // Never a cleanup: this file belongs to the user's project, not to PPM.
  });
  if ("error" in started) return c.json(err(started.error), started.status);
  return c.json(ok({ ...started, filename: basename(target) }));
});

/** Every .apk in a project, so the picker can offer them without a file browser. */
androidRoutes.get("/projects/:project/apks", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;
  const project = configService.get("projects").find((p) => p.name === c.req.param("project"));
  if (!project) return c.json(err("no such project"), 404);
  return c.json(ok({ apks: await findProjectApks(resolve(project.path)) }));
});

/* =============================================================================================
 * Phase 4 — the device manager: create, wipe and delete an AVD.
 *
 * Three rules run through all of it, and each is a line in the plan:
 *
 *  - **Typed wrappers, never a shell string.** The browser picks a device profile and a system
 *    image out of lists these routes produced; it never supplies a flag or a path.
 *  - **Destructive work only when the AVD is stopped**, and only after the caller has typed the
 *    name back. A confirmation the client could skip is not a confirmation, so the name is
 *    checked here rather than only in the dialog.
 *  - **PPM never accepts an SDK licence or starts a download.** Installing a system image is
 *    out of scope; these routes only ever offer what the host already has.
 * ============================================================================================= */

androidRoutes.get("/system-images", async (c) => {
  const rejected = assertEnabled(c);
  if (rejected) return rejected;
  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  const images = listSystemImages(sdk.root).map((i) => ({
    ...i,
    hostCompatible: abiMatchesHost(i.abi),
    // The absolute sysdir would name the user's home in a browser payload for no benefit.
    sysdir: undefined,
  }));
  return c.json(ok({ images, canInstallMore: sdk.sdkmanager.path !== null }));
});

androidRoutes.get("/device-profiles", async (c) => {
  const rejected = assertEnabled(c);
  if (rejected) return rejected;
  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  if (!sdk.avdmanager.path) {
    return c.json(err("the SDK command-line tools are not installed — no device profiles to offer"), 400);
  }
  return c.json(ok({ profiles: await listDeviceProfiles(sdk.avdmanager.path) }));
});

androidRoutes.post("/avds", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const body = await c.req.json().catch(() => null) as Partial<CreateAvdRequest> | null;
  if (typeof body?.name !== "string" || typeof body?.systemImage !== "string"
      || typeof body?.deviceProfile !== "string") {
    return c.json(err("name, systemImage and deviceProfile are required"), 400);
  }
  const nameProblem = validateAvdName(body.name);
  if (nameProblem) return c.json(err(nameProblem), 400);

  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  if (!sdk.avdmanager.path) {
    return c.json(err("the SDK command-line tools are not installed — PPM cannot create an AVD"), 400);
  }

  const result = await createAvd({
    name: body.name,
    systemImage: body.systemImage,
    deviceProfile: body.deviceProfile,
    ramMb: numberOrUndefined(body.ramMb),
    storageMb: numberOrUndefined(body.storageMb),
    sdCardMb: numberOrUndefined(body.sdCardMb),
    avdmanagerPath: sdk.avdmanager.path,
    avdHome: sdk.avdHome,
    images: listSystemImages(sdk.root),
  });
  if (!result.ok) return c.json(err(result.message), 400);
  return c.json(ok({ avd: result.avd }));
});

/**
 * Both destructive routes share this: the AVD must exist, be stopped, and the caller must have
 * typed its name back. Studio holding the lock counts as "not stopped" — plan §5, and the lock
 * is reported, never deleted.
 */
async function assertDestructible(avdId: string, confirmName: unknown): Promise<
  { ok: true; device: DeviceEntry; dir: string } | { ok: false; error: string; status: 400 | 404 | 409 }
> {
  const home = await avdHome();
  const device = listDevices(home).find((d) => d.avdId === avdId);
  if (!device) return { ok: false, error: "no such AVD", status: 404 };
  if (device.runtime) {
    return { ok: false, error: `${device.name} is running — stop it first`, status: 409 };
  }
  if (device.lockedByAnotherProcess) {
    return { ok: false, error: `${device.name} is locked by another process — it is probably open in Android Studio`, status: 409 };
  }
  if (confirmName !== device.name) {
    return { ok: false, error: `type ${device.name} to confirm`, status: 400 };
  }
  // The directory comes from the *listing*, not from joining the name onto the AVD home: the
  // display name is read out of `config.ini` and need not match the directory it came from.
  const summary = listAvds(home).find((a) => a.avdId === avdId);
  if (!summary) return { ok: false, error: "no such AVD", status: 404 };
  return { ok: true, device, dir: summary.dir };
}

androidRoutes.post("/avds/:avdId/wipe", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const body = await c.req.json().catch(() => null) as { confirmName?: unknown } | null;
  const allowed = await assertDestructible(c.req.param("avdId"), body?.confirmName);
  if (!allowed.ok) return c.json(err(allowed.error), allowed.status);

  const outcome = wipeAvdData(allowed.dir);
  if (!outcome.ok) return c.json(err(outcome.message), 400);
  return c.json(ok({ removed: outcome.removed, freedBytes: outcome.freedBytes, message: outcome.message }));
});

androidRoutes.delete("/avds/:avdId", async (c) => {
  const rejected = assertControlAllowed(c);
  if (rejected) return rejected;

  const body = await c.req.json().catch(() => null) as { confirmName?: unknown } | null;
  const allowed = await assertDestructible(c.req.param("avdId"), body?.confirmName ?? c.req.query("confirmName"));
  if (!allowed.ok) return c.json(err(allowed.error), allowed.status);

  const sdk = await discoverSdk(androidConfig().sdk_root ?? null);
  if (!sdk.avdmanager.path) {
    return c.json(err("the SDK command-line tools are not installed — PPM cannot delete an AVD"), 400);
  }
  const result = await deleteAvd(sdk.avdmanager.path, allowed.device.name, sdk.avdHome);
  if (!result.ok) return c.json(err(result.message), 400);

  // Ownership is keyed by AVD name and would otherwise outlive the AVD, handing stop rights to
  // whatever is created with that name next.
  releaseOwnership(allowed.device.name);
  return c.json(ok({ deleted: allowed.device.name }));
});

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
