import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { err } from "../../types/api.ts";
import { mapFsError } from "../../services/fs-path-guard.service.ts";

/** Shared by `/designs` and the sub-routers mounted under it. */

export type DesignRouteEnv = { Variables: { projectPath: string; projectName: string } };

/** Answers with the status a service error carries; logs only what is the server's fault. */
export function designFail(c: Context<DesignRouteEnv>, e: unknown): Response {
  const info = mapFsError(e);
  if (info.status >= 500) console.error(`[design] ${c.req.method} ${c.req.path}: ${info.message}`);
  return c.json(err(info.message), info.status as ContentfulStatusCode);
}

/** The request's JSON body when it is an object, else null. */
export async function designJsonBody(c: Context<DesignRouteEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
