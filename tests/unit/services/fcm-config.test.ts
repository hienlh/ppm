import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import {
  androidClientConfig,
  fcmStatus,
  loadFcmConfig,
  saveFcmConfig,
  validateFcmUpdate,
} from "../../../src/services/fcm/fcm-config.ts";
import { isSecretConfigKey } from "../../../src/services/config-secret-keys.ts";
import { makeGoogleServices, makeServiceAccount, PROJECT_ID, PROJECT_NUMBER, type TestServiceAccount } from "../../helpers/fcm-fixtures.ts";

let sa: TestServiceAccount;
beforeAll(async () => { sa = await makeServiceAccount(); });
beforeEach(() => { setDb(openTestDb()); });

describe("androidClientConfig", () => {
  it("picks PPM's app out of a file with two clients", () => {
    expect(androidClientConfig(makeGoogleServices())).toEqual({
      ok: true,
      value: {
        apiKey: "AIzaSyPPM-public-key-000000000000000",
        appId: `1:${PROJECT_NUMBER}:android:ppmapp0000000000`,
        senderId: PROJECT_NUMBER,
        projectId: PROJECT_ID,
        storageBucket: `${PROJECT_ID}.firebasestorage.app`,
      },
    });
  });

  it("says so when the file has no app for PPM's package", () => {
    const result = androidClientConfig(makeGoogleServices({ packages: ["com.example.other"] }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("com.hienlh.ppm");
  });

  it("refuses something that is not google-services.json", () => {
    expect(androidClientConfig({ hello: "world" })).toMatchObject({ ok: false });
  });
});

describe("validateFcmUpdate", () => {
  it("accepts both files, as objects or as their text", async () => {
    const asObjects = await validateFcmUpdate({ googleServices: makeGoogleServices(), serviceAccount: sa.json }, null);
    expect(asObjects.ok).toBe(true);
    const asText = await validateFcmUpdate({ googleServices: JSON.stringify(makeGoogleServices()), serviceAccount: JSON.stringify(sa.json) }, null);
    expect(asText.ok).toBe(true);
  });

  it("refuses two files from different projects, naming both", async () => {
    const other = await makeServiceAccount("someone-elses-project");
    const result = await validateFcmUpdate({ googleServices: makeGoogleServices(), serviceAccount: other.json }, null);
    expect(result.ok).toBe(false);
    const { error } = result as { error: string };
    expect(error).toContain(PROJECT_ID);
    expect(error).toContain("someone-elses-project");
  });

  it("refuses a file without PPM's package", async () => {
    const result = await validateFcmUpdate({ googleServices: makeGoogleServices({ packages: ["com.example.other"] }), serviceAccount: sa.json }, null);
    expect((result as { error: string }).error).toContain("com.hienlh.ppm");
  });

  it("refuses a service account that is not one, or whose key cannot be read", async () => {
    const gs = makeGoogleServices();
    for (const bad of [
      { ...sa.json, type: "authorized_user" },
      { ...sa.json, client_email: "" },
      { ...sa.json, private_key: undefined },
      { ...sa.json, private_key: "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n" },
      "{ not json",
      42,
    ]) {
      const result = await validateFcmUpdate({ googleServices: gs, serviceAccount: bad }, null);
      expect(result.ok).toBe(false);
    }
  });

  it("asks for the missing file the first time, and keeps a saved one afterwards", async () => {
    expect(await validateFcmUpdate({ googleServices: makeGoogleServices() }, null)).toMatchObject({ ok: false, error: "Add the service account key too" });
    expect(await validateFcmUpdate({}, null)).toMatchObject({ ok: false });
    const first = await validateFcmUpdate({ googleServices: makeGoogleServices(), serviceAccount: sa.json }, null);
    if (!first.ok) throw new Error(first.error);
    const rotated = await makeServiceAccount();
    const second = await validateFcmUpdate({ serviceAccount: rotated.json }, first.value);
    expect(second.ok && second.value.serviceAccount.private_key).toBe(rotated.json.private_key as string);
    expect(second.ok && second.value.googleServices).toEqual(first.value.googleServices);
  });
});

describe("the fcm row", () => {
  it("is a secret config key", () => {
    expect(isSecretConfigKey("fcm")).toBe(true);
    expect(isSecretConfigKey("fcm.serviceAccount.private_key")).toBe(true);
  });

  it("round-trips, and its status carries nothing from the service account", async () => {
    expect(fcmStatus()).toEqual({ configured: false, android: null });
    const checked = await validateFcmUpdate({ googleServices: makeGoogleServices(), serviceAccount: sa.json }, null);
    if (!checked.ok) throw new Error(checked.error);
    saveFcmConfig(checked.value);
    expect(loadFcmConfig()?.serviceAccount.client_email).toBe(sa.json.client_email as string);
    const status = fcmStatus();
    expect(status.configured).toBe(true);
    expect(status.projectId).toBe(PROJECT_ID);
    const text = JSON.stringify(status);
    for (const field of ["private_key", "client_email", "private_key_id", "client_id"]) {
      expect(text).not.toContain(String(sa.json[field]));
    }
  });
});
