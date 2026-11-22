/**
 * Firebase test fixtures: a service-account key minted per run, a google-services.json, and a
 * loopback stand-in for Google's token endpoint and FCM HTTP v1 (`PPM_FCM_OAUTH_BASE` /
 * `PPM_FCM_API_BASE`). Nothing here reaches Google.
 */

export const PROJECT_ID = "ppm-test-1a2b3";
export const PROJECT_NUMBER = "123456789012";

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export interface TestServiceAccount {
  json: Record<string, unknown>;
  publicKey: CryptoKey;
}

/** A service account with a freshly generated RSA key, and the public half to check its signatures. */
export async function makeServiceAccount(projectId = PROJECT_ID): Promise<TestServiceAccount> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    publicKey: pair.publicKey,
    json: {
      type: "service_account",
      project_id: projectId,
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: toPem(pkcs8, "PRIVATE KEY"),
      client_email: `firebase-adminsdk-abcde@${projectId}.iam.gserviceaccount.com`,
      client_id: "109876543210987654321",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    },
  };
}

/** What the Firebase console downloads: here with a second Android app before PPM's. */
export function makeGoogleServices(opts: { projectId?: string; packages?: string[] } = {}): Record<string, unknown> {
  const projectId = opts.projectId ?? PROJECT_ID;
  const packages = opts.packages ?? ["com.example.other", "com.hienlh.ppm"];
  return {
    project_info: {
      project_number: PROJECT_NUMBER,
      project_id: projectId,
      storage_bucket: `${projectId}.firebasestorage.app`,
    },
    client: packages.map((pkg, i) => ({
      client_info: {
        mobilesdk_app_id: `1:${PROJECT_NUMBER}:android:${pkg === "com.hienlh.ppm" ? "ppmapp" : `other${i}`}0000000000`,
        android_client_info: { package_name: pkg },
      },
      oauth_client: [],
      api_key: [{ current_key: pkg === "com.hienlh.ppm" ? "AIzaSyPPM-public-key-000000000000000" : "AIzaSyOTHER-key-0000000000000000000" }],
      services: { appinvite_service: { other_platform_oauth_client: [] } },
    })),
    configuration_version: "1",
  };
}

export interface FakeGoogleRequest {
  path: string;
  headers: Headers;
  body: string;
}

export interface FakeGoogle {
  base: string;
  requests: FakeGoogleRequest[];
  tokenCalls: () => number;
  sends: () => Array<{ auth: string | null; json: any }>;
  /** The answer to a send, by device token. Default 200. */
  respond: (token: string) => Response;
  tokenResponse: () => Response;
  stop: () => void;
}

export function startFakeGoogle(): FakeGoogle {
  const fake: FakeGoogle = {
    base: "",
    requests: [],
    tokenCalls: () => fake.requests.filter((r) => r.path === "/token").length,
    sends: () => fake.requests.filter((r) => r.path.endsWith("/messages:send")).map((r) => ({ auth: r.headers.get("authorization"), json: JSON.parse(r.body) })),
    respond: () => Response.json({ name: `projects/${PROJECT_ID}/messages/1` }),
    tokenResponse: () => Response.json({ access_token: `ya29.fake-${fake.tokenCalls()}`, expires_in: 3599, token_type: "Bearer" }),
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      fake.requests.push({ path, headers: req.headers, body });
      if (path === "/token") return fake.tokenResponse();
      if (path === `/v1/projects/${PROJECT_ID}/messages:send`) {
        const token = JSON.parse(body)?.message?.token as string;
        return fake.respond(token);
      }
      return new Response("not found", { status: 404 });
    },
  });
  fake.base = `http://127.0.0.1:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

/** FCM's answer for a token that is gone. */
export function unregistered(): Response {
  return Response.json({
    error: {
      code: 404,
      message: "Requested entity was not found.",
      status: "NOT_FOUND",
      details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
    },
  }, { status: 404 });
}

/** FCM's answer for a string that was never a token. */
export function invalidToken(): Response {
  return Response.json({
    error: {
      code: 400,
      message: "The registration token is not a valid FCM registration token",
      status: "INVALID_ARGUMENT",
      details: [
        { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
        { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.token", description: "Invalid registration token" }] },
      ],
    },
  }, { status: 400 });
}
