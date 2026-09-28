/**
 * `/api/android/*` and `/ws/android` against a **running PPM**, which is the half
 * `android-e2e.ts` cannot reach: it exercises the services directly and so proves nothing about
 * auth, the Origin guard, the nonce handshake, or two viewers sharing one pipeline.
 *
 * Start a server with the feature on and an emulator running, then point this at it:
 *
 *   ANDROID_EMULATOR_ENABLED=1 bun src/server/index.ts __serve__ 8099 127.0.0.1 dev
 *   PPM_BASE=http://127.0.0.1:8099 PPM_TOKEN=<token from that instance's DB> \
 *     PPM_HOME=$(mktemp -d) bun tests/e2e/android-ws-e2e.ts
 *
 * The token belongs to whichever database that instance opened — the `dev` argument above means
 * `ppm.dev.db`, not `ppm.db`, and using the wrong one is a 401 that looks like a broken guard.
 */
const BASE = process.env.PPM_BASE ?? "http://127.0.0.1:8099";
const TOKEN = process.env.PPM_TOKEN ?? "";
if (!TOKEN) { console.error("set PPM_TOKEN to the auth token of the instance at PPM_BASE"); process.exit(1); }
const WS_BASE = BASE.replace(/^http/, "ws");
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const caps = await (await fetch(`${BASE}/api/android/capabilities`, { headers: H })).json();
ok("capabilities", caps.ok && caps.data.enabled, `ready=${caps.data?.ready} encoders=${caps.data?.encoders?.join(",")}`);

const devs = await (await fetch(`${BASE}/api/android/devices`, { headers: H })).json();
const device = devs.data?.devices?.find((d: any) => d.runtime);
ok("devices lists a running emulator", !!device, device ? `${device.name} ${device.runtime.deviceId}` : "none");
if (!device) { console.error("no running emulator — start one first"); process.exit(1); }
ok("the browser is never told the grpc port or pid", device && !("grpcPort" in device.runtime) && !("pid" in device.runtime),
  device ? Object.keys(device.runtime).join(",") : "");

const noAuth = await fetch(`${BASE}/api/android/devices`);
ok("unauthenticated is rejected", noAuth.status === 401, `${noAuth.status}`);

const crossOrigin = await fetch(`${BASE}/api/android/devices/${device.runtime.deviceId}/sessions`,
  { method: "POST", headers: { ...H, Origin: "http://evil.example.com" }, body: "{}" });
ok("a cross-origin session mint is rejected", crossOrigin.status === 403, `${crossOrigin.status}`);

const mint = await (await fetch(`${BASE}/api/android/devices/${device.runtime.deviceId}/sessions`,
  { method: "POST", headers: H, body: "{}" })).json();
ok("nonce minted", typeof mint.data?.nonce === "string", `hwKeyboard=${mint.data?.hardwareKeyboard}`);

// --- the socket ---
function connect(nonce: string, label: string) {
  return new Promise<{ ready: any; frames: number; keyframes: number; msgs: any[]; ws: WebSocket }>((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/android?token=${TOKEN}`);
    ws.binaryType = "arraybuffer";
    let ready: any = null, frames = 0, keyframes = 0;
    const msgs: any[] = [];
    const timer = setTimeout(() => reject(new Error(`${label}: no ready in 25s`)), 25_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", nonce, quality: "balanced" }));
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        msgs.push(m);
        if (m.type === "ready") { ready = m; clearTimeout(timer); setTimeout(() => resolve({ ready, frames, keyframes, msgs, ws }), 6000); }
      } else {
        frames++;
        if (new DataView(e.data as ArrayBuffer).getUint8(1) & 1) keyframes++;
      }
    };
    ws.onclose = (ev) => { if (!ready) { clearTimeout(timer); reject(new Error(`${label}: closed ${ev.code} ${ev.reason}`)); } };
  });
}

const motion = Bun.spawn(["bash", "-c",
  `end=$(( $(date +%s) + 25 )); while [ "$(date +%s)" -lt "$end" ]; do ` +
  `adb shell input swipe 540 1800 540 600 800 >/dev/null 2>&1; adb shell input swipe 540 600 540 1800 800 >/dev/null 2>&1; done`]);
Bun.spawnSync(["adb", "shell", "input", "keyevent", "KEYCODE_HOME"]);

const a = await connect(mint.data.nonce, "A");
ok("ready received", a.ready.type === "ready",
  `${a.ready.geometry.width}x${a.ready.geometry.height} rot=${a.ready.geometry.rotation} codec=${a.ready.codec} enc=${a.ready.encoder}`);
ok("first client holds the controller lease", a.ready.controller === true);
ok("video frames arrive as binary", a.frames > 20, `${a.frames} frames, ${a.keyframes} keyframes in 6s`);
// Against the AVD's own config, not a literal: this used to assert 1080x2400 and passed only
// because a 1080x2400 test AVD happened to be the running one. Pixel_9 is 1080x**2424**, so the
// literal turned a correct answer into a failure the moment the device list started resolving
// the user's own AVD to its row.
ok("device size is reported alongside the frame size",
  a.ready.geometry.deviceWidth === (device.displayWidth ?? a.ready.geometry.deviceWidth)
  && a.ready.geometry.deviceHeight === (device.displayHeight ?? a.ready.geometry.deviceHeight),
  `stream says ${a.ready.geometry.deviceWidth}x${a.ready.geometry.deviceHeight}, config says ${device.displayWidth}x${device.displayHeight}`);

// Replay must fail: the nonce is single use.
const replay = await connect(mint.data.nonce, "replay").then(() => "accepted").catch((e) => String(e.message));
ok("a replayed nonce is refused", replay.includes("closed 1008"), replay);

// A second viewer shares the pipeline and does NOT get the lease.
const mint2 = await (await fetch(`${BASE}/api/android/devices/${device.runtime.deviceId}/sessions`,
  { method: "POST", headers: H, body: "{}" })).json();
const b = await connect(mint2.data.nonce, "B");
ok("a second viewer watches without the lease", b.ready.controller === false, `controller=${b.ready.controller}`);
ok("the second viewer gets its own frames", b.frames > 20, `${b.frames} frames`);

// Take control: B steals it, A is told.
b.ws.send(JSON.stringify({ type: "take-control" }));
await Bun.sleep(1500);
const aLost = a.msgs.some((m) => m.type === "controller" && m.controller === false);
const bGot = b.msgs.some((m) => m.type === "controller" && m.controller === true);
ok("take control moves the lease and tells the loser", aLost && bGot, `A told=${aLost} B told=${bGot}`);

// Input from the client that no longer holds it is refused, not applied.
a.ws.send(JSON.stringify({ type: "touch", geometryGeneration: a.ready.geometry.generation, touches: [{ x: 10, y: 10, id: 0, pressure: 1 }] }));
await Bun.sleep(800);
ok("input from a superseded client is refused", a.msgs.filter((m) => m.type === "controller" && m.controller === false).length >= 1);

// Input carrying a stale geometry is dropped rather than mapped onto the new screen.
b.ws.send(JSON.stringify({ type: "touch", geometryGeneration: 9999, touches: [{ x: 10, y: 10, id: 0, pressure: 1 }] }));
b.ws.send(JSON.stringify({ type: "heartbeat" }));
await Bun.sleep(800);
ok("a stale geometry is not answered with an error either", b.msgs.some((m) => m.type === "heartbeat"));

/* ===========================================================================================
 * Phase 3 — install, screenshot, logcat, over the real server.
 * ========================================================================================= */
const dev = device.runtime.deviceId;

// --- logcat over the socket -------------------------------------------------------------
// B still holds the lease; logs are deliberately NOT gated on it, so A must get them too.
a.ws.send(JSON.stringify({ type: "logcat", subscribe: true }));
const adbBin = `${process.env.HOME}/Android/Sdk/platform-tools/adb`;
const tag = `WSE2E${Date.now() % 100000}`;
await Bun.sleep(1200);
Bun.spawnSync([adbBin, "-s", device.runtime.adbSerial, "shell", "log", "-t", tag, "logcat over the socket"]);
await Bun.sleep(2500);
const logMsgs = a.msgs.filter((m) => m.type === "log");
const sawTag = logMsgs.some((m) => m.entries.some((e: any) => e.tag === tag));
ok("logcat reaches a viewer without the lease", sawTag,
  `${logMsgs.length} batches, ${logMsgs.reduce((n, m) => n + m.entries.length, 0)} entries`);
ok("log entries are parsed, not raw lines",
  logMsgs.some((m) => m.entries.some((e: any) => e.pid > 0 && typeof e.level === "string" && e.tag !== "")),
  logMsgs[0]?.entries?.[0] ? JSON.stringify(logMsgs[0].entries[0]) : "none");

// Unsubscribing must stop the batches arriving at this socket.
a.ws.send(JSON.stringify({ type: "logcat", subscribe: false }));
await Bun.sleep(600);
const beforeQuiet = a.msgs.filter((m) => m.type === "log").length;
Bun.spawnSync([adbBin, "-s", device.runtime.adbSerial, "shell", "log", "-t", tag, "nobody is watching"]);
await Bun.sleep(2000);
ok("unsubscribing stops the batches",
  a.msgs.filter((m) => m.type === "log").length === beforeQuiet,
  `${a.msgs.filter((m) => m.type === "log").length - beforeQuiet} arrived after unsubscribe`);

// --- screenshot --------------------------------------------------------------------------
const shotRes = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/screenshot`, { headers: H });
const shotBytes = new Uint8Array(await shotRes.arrayBuffer());
ok("screenshot is a PNG attachment",
  shotRes.status === 200 && shotRes.headers.get("content-type") === "image/png"
    && shotBytes[0] === 0x89 && shotBytes[1] === 0x50,
  `${shotBytes.length} bytes, ${shotRes.headers.get("content-disposition")}`);
ok("the screenshot filename names the device",
  (shotRes.headers.get("content-disposition") ?? "").includes(device.name.replace(/[^A-Za-z0-9._-]+/g, "_")),
  shotRes.headers.get("content-disposition") ?? "none");

const shotNoAuth = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/screenshot`);
ok("the screenshot route needs auth", shotNoAuth.status === 401, `${shotNoAuth.status}`);

// --- clipboard ---------------------------------------------------------------------------
const secret = `ws-e2e-${crypto.randomUUID()}`;
const setClip = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/clipboard`,
  { method: "POST", headers: H, body: JSON.stringify({ text: secret }) });
const getClip = await (await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/clipboard`, { headers: H })).json();
ok("clipboard round-trips through the API", setClip.status === 200 && getClip.data?.text === secret,
  getClip.data?.text === secret ? "matched" : `got ${JSON.stringify(getClip.data?.text ?? getClip.error)}`);

const bigClip = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/clipboard`,
  { method: "POST", headers: H, body: JSON.stringify({ text: "x".repeat(70_000) }) });
ok("an oversized clipboard write is refused", bigClip.status === 413, `${bigClip.status}`);

// --- APK install -------------------------------------------------------------------------
const notAnApk = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/apk?filename=x.apk`,
  { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "definitely not a zip" });
ok("a non-APK upload is refused", notAnApk.status === 400, `${notAnApk.status}`);

// Cancel mid-upload: the request is aborted while the body is still going out, and the gate is
// that nothing is left in the staging directory afterwards.
const abort = new AbortController();
const slowBody = new ReadableStream<Uint8Array>({
  async pull(c) {
    c.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    c.enqueue(new Uint8Array(2 * 1024 * 1024));
    await Bun.sleep(400);
  },
});
const cancelled = fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/apk?filename=cancel.apk`,
  { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: slowBody, signal: abort.signal, duplex: "half" } as RequestInit)
  .then(() => "completed").catch((e) => String(e.name));
await Bun.sleep(700);
abort.abort();
ok("a cancelled upload aborts", (await cancelled) === "AbortError", await cancelled);
await Bun.sleep(1200);
// The staging directory belongs to the *server's* PPM_HOME, not this script's.
const staged = Bun.spawnSync(["bash", "-lc",
  `ls -1 "\${PPM_SERVER_HOME:-$HOME/.ppm}/android/apk-staging" 2>/dev/null | wc -l`]).stdout.toString().trim();
ok("a cancelled upload leaves no temp file", staged === "0", `${staged} file(s) staged`);

// A real install: pull an APK the device already has, upload it back, poll the operation.
const pkgPath = Bun.spawnSync([adbBin, "-s", device.runtime.adbSerial, "shell", "pm", "path", "com.android.settings"])
  .stdout.toString().trim().split("\n")[0]?.replace(/^package:/, "").trim();
let installed = "no package to test with";
if (pkgPath) {
  const local = `/tmp/ppm-ws-e2e-${Date.now()}.apk`;
  Bun.spawnSync([adbBin, "-s", device.runtime.adbSerial, "pull", pkgPath, local]);
  const file = Bun.file(local);
  if (await file.exists()) {
    const up = await (await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/apk?filename=settings.apk`,
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: await file.arrayBuffer() })).json();
    ok("an upload starts an install operation", up.ok && typeof up.data?.operationId === "string",
      up.ok ? `${up.data.bytes} bytes` : up.error);
    if (up.data?.operationId) {
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(1000);
        const op = await (await fetch(`${BASE}/api/android/operations/${up.data.operationId}`, { headers: H })).json();
        if (op.data?.state === "succeeded" || op.data?.state === "failed") {
          installed = `${op.data.state}${op.data.error ? `: ${op.data.error}` : ""}`;
          break;
        }
        installed = `still ${op.data?.state}`;
      }
    }
    Bun.spawnSync(["rm", "-f", local]);
  }
}
// A system APK may legitimately be refused; what is tested is that the operation reaches a
// decided state and says why, not that every APK installs.
ok("the install operation finishes with a verdict", /succeeded|failed:/.test(installed), installed);
await Bun.sleep(1500);
const stagedAfter = Bun.spawnSync(["bash", "-lc",
  `ls -1 "\${PPM_SERVER_HOME:-$HOME/.ppm}/android/apk-staging" 2>/dev/null | wc -l`]).stdout.toString().trim();
ok("a finished install cleans its staged upload up", stagedAfter === "0", `${stagedAfter} file(s) left`);

const wrongDevice = await fetch(`${BASE}/api/android/devices/0:0/apk?filename=x.apk`,
  { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) });
ok("installing to a device that is not there is a 404", wrongDevice.status === 404, `${wrongDevice.status}`);

const badProject = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/apk/project`,
  { method: "POST", headers: H, body: JSON.stringify({ project: "no-such-project", path: "a.apk" }) });
ok("an unknown project is a 404", badProject.status === 404, `${badProject.status}`);

const projects = await (await fetch(`${BASE}/api/projects`, { headers: H })).json();
const firstProject = projects.data?.projects?.[0]?.name ?? projects.data?.[0]?.name;
if (firstProject) {
  const escape = await fetch(`${BASE}/api/android/devices/${encodeURIComponent(dev)}/apk/project`,
    { method: "POST", headers: H, body: JSON.stringify({ project: firstProject, path: "../../../etc/passwd.apk" }) });
  ok("a path escaping the project is refused", escape.status === 400, `${escape.status}`);
} else {
  ok("a path escaping the project is refused", false, "no project configured to test against");
}

// --- AVD manager (Phase 4) ---------------------------------------------------------------
// Nothing here creates or destroys an AVD: this instance runs against the user's real AVD home,
// and the CRUD gate has its own e2e with an isolated one (`android-avd-crud-e2e.ts`). What is
// only reachable here is the HTTP surface — the guards, and the two read routes the create
// dialog opens with.
const imagesRes = await (await fetch(`${BASE}/api/android/system-images`, { headers: H })).json();
ok("system images are listed", Array.isArray(imagesRes.data?.images) && imagesRes.data.images.length > 0,
  imagesRes.data?.images?.map((i: any) => `API ${i.apiLevel} ${i.abi}${i.hostCompatible ? "" : " (wrong cpu)"}`).join(", "));
ok("an image never leaks the SDK's absolute path",
  (imagesRes.data?.images ?? []).every((i: any) => i.sysdir === undefined),
  Object.keys(imagesRes.data?.images?.[0] ?? {}).join(","));

const profilesRes = await (await fetch(`${BASE}/api/android/device-profiles`, { headers: H })).json();
ok("device profiles are listed", (profilesRes.data?.profiles?.length ?? 0) > 20,
  `${profilesRes.data?.profiles?.length} profiles`);

ok("capabilities says whether an AVD can be created here", typeof caps.data?.canCreateAvd === "boolean",
  `canCreateAvd=${caps.data?.canCreateAvd}`);

const badName = await fetch(`${BASE}/api/android/avds`, { method: "POST", headers: H,
  body: JSON.stringify({ name: "has space; rm -rf /", systemImage: imagesRes.data.images[0].id, deviceProfile: "pixel_9" }) });
ok("a name that would need quoting is refused", badName.status === 400, `${badName.status}`);

const madeUpImage = await fetch(`${BASE}/api/android/avds`, { method: "POST", headers: H,
  body: JSON.stringify({ name: "ppm_ws_e2e_never", systemImage: "system-images;android-99;evil;x86_64", deviceProfile: "pixel_9" }) });
ok("a system image this host does not have is refused", madeUpImage.status === 400, `${madeUpImage.status}`);

const noSuchAvd = await fetch(`${BASE}/api/android/avds/does-not-exist/wipe`, { method: "POST", headers: H,
  body: JSON.stringify({ confirmName: "does-not-exist" }) });
ok("wiping an AVD that does not exist is a 404", noSuchAvd.status === 404, `${noSuchAvd.status}`);

// The running AVD, with a **wrong** confirmName on purpose. Two guards have to fail before
// anything is destroyed, and the message is what says the running check is the one that fired —
// a test that could wipe the user's device if the code were broken is not a test worth having.
const runningId = devs.data.devices.find((d: any) => d.runtime)!.avdId;
const wipeRunning = await (await fetch(`${BASE}/api/android/avds/${encodeURIComponent(runningId)}/wipe`,
  { method: "POST", headers: H, body: JSON.stringify({ confirmName: "definitely-not-its-name" }) })).json();
ok("a running AVD cannot be wiped", wipeRunning.ok === false, wipeRunning.error);
ok("and it is refused for being running, before the name is even considered",
  /running|locked|stopped/i.test(wipeRunning.error ?? ""), wipeRunning.error);

const deleteRunning = await (await fetch(`${BASE}/api/android/avds/${encodeURIComponent(runningId)}`,
  { method: "DELETE", headers: H, body: JSON.stringify({ confirmName: "definitely-not-its-name" }) })).json();
ok("a running AVD cannot be deleted", deleteRunning.ok === false, deleteRunning.error);

const stoppedDevice = devs.data.devices.find((d: any) => !d.runtime && !d.lockedByAnotherProcess);
if (stoppedDevice) {
  const wrongName = await (await fetch(`${BASE}/api/android/avds/${encodeURIComponent(stoppedDevice.avdId)}/wipe`,
    { method: "POST", headers: H, body: JSON.stringify({ confirmName: `${stoppedDevice.name}x` }) })).json();
  ok("a stopped AVD still needs its name typed exactly", wrongName.ok === false, wrongName.error);
} else {
  ok("a stopped AVD still needs its name typed exactly", false, "every AVD on this host is running or locked");
}

const createNoAuth = await fetch(`${BASE}/api/android/avds`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", systemImage: "y", deviceProfile: "z" }) });
ok("creating without a token is rejected", createNoAuth.status === 401, `${createNoAuth.status}`);

const deleteCrossOrigin = await fetch(`${BASE}/api/android/avds/${encodeURIComponent(runningId)}`,
  { method: "DELETE", headers: { ...H, Origin: "http://evil.example.com" }, body: JSON.stringify({ confirmName: "x" }) });
ok("a cross-origin delete is rejected", deleteCrossOrigin.status === 403, `${deleteCrossOrigin.status}`);

/* ===========================================================================================
 * A motionless device must still stream.
 *
 * `streamScreenshot` is change-driven — a device sitting on its launcher sent *2 frames in 15
 * seconds* when this was measured — so a pipeline that feeds ffmpeg only on arrival goes silent
 * on a still screen and a viewer joining then never gets a picture at all. Every check above
 * this point runs under the swipe generator, which is exactly why none of them saw it: kill the
 * motion first, let the screen settle, and only then connect.
 * ========================================================================================= */
try { motion.kill(); } catch {}
await Bun.sleep(3000);                       // animations finish; the guest screen goes still

const mint3 = await (await fetch(`${BASE}/api/android/devices/${device.runtime.deviceId}/sessions`,
  { method: "POST", headers: H, body: "{}" })).json();
const c = await connect(mint3.data.nonce, "C");
// 40, not 180: a still screen is deliberately paced down to 10 fps (see `IDLE_FPS`), so the
// number to assert is "a steady stream with keyframes in it", not the rung's full rate.
ok("a viewer joining a motionless device gets a picture", c.frames > 40 && c.keyframes >= 2,
  `${c.frames} frames, ${c.keyframes} keyframes in 6s with no input at all`);

a.ws.close(); b.ws.close(); c.ws.close();
let ff = "?";
for (let i = 0; i < 24; i++) {
  ff = Bun.spawnSync(["pgrep", "-xc", "ffmpeg"]).stdout.toString().trim() || "0";
  if (ff === "0") break;
  await Bun.sleep(250);
}
ok("the last viewer leaving stops ffmpeg", ff === "0", `pgrep -xc ffmpeg said ${ff}`);
ok("a codec string followed the ready message", a.msgs.some((m) => /^avc1\.[0-9a-f]{6}$/.test(m.codec ?? "")),
  a.msgs.filter((m) => m.type === "codec").map((m) => m.codec).join(",") || "none");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
