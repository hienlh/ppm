import { describe, expect, test } from "bun:test";
import { postgresService } from "../../../src/services/postgres.service.ts";

/**
 * Covers the connect-phase retry in PostgresService.
 *
 * The first connect to a remote host over a cold network path can spend ~20s on TCP
 * SYN retransmits and then fail outright, while an immediate second attempt succeeds.
 * These tests drive that loop through stubbed internals so they stay fast and
 * deterministic, and pin down the rule that keeps a retried write from being applied
 * twice: only failures raised before the query reached the server may be replayed.
 */

type Svc = {
  connect: (cs: string) => unknown;
  disconnect: (cs: string) => Promise<void>;
  withConnection: <T>(cs: string, fn: (sql: unknown) => Promise<T>) => Promise<T>;
};

/** Swap the real pool plumbing for stubs, run the body, then restore. */
async function withStubbedPool(
  body: (svc: Svc, state: { disconnects: number }) => Promise<void>,
): Promise<void> {
  const svc = postgresService as unknown as Svc;
  const realConnect = svc.connect;
  const realDisconnect = svc.disconnect;
  const state = { disconnects: 0 };
  svc.connect = () => ({ marker: "stub-pool" });
  svc.disconnect = async () => { state.disconnects++; };
  try {
    await body(svc, state);
  } finally {
    svc.connect = realConnect;
    svc.disconnect = realDisconnect;
  }
}

function err(code: string): Error {
  return Object.assign(new Error(`write ${code} host:5432`), { code });
}

describe("PostgresService connect-phase retry", () => {
  test("replays the operation once when the first connect times out", async () => {
    await withStubbedPool(async (svc, state) => {
      let attempts = 0;
      const result = await svc.withConnection("postgres://x", async () => {
        attempts++;
        if (attempts === 1) throw err("CONNECT_TIMEOUT");
        return "second-attempt-value";
      });
      expect(attempts).toBe(2);
      expect(result).toBe("second-attempt-value");
      // The pool that failed to connect is discarded before the retry.
      expect(state.disconnects).toBe(1);
    });
  });

  test("replays a refused connection, the cold-path failure seen in practice", async () => {
    await withStubbedPool(async (svc) => {
      let attempts = 0;
      const result = await svc.withConnection("postgres://x", async () => {
        attempts++;
        if (attempts === 1) throw err("ECONNREFUSED");
        return "ok";
      });
      expect(attempts).toBe(2);
      expect(result).toBe("ok");
    });
  });

  test("gives up after a single retry rather than looping", async () => {
    await withStubbedPool(async (svc) => {
      let attempts = 0;
      await expect(svc.withConnection("postgres://x", async () => {
        attempts++;
        throw err("CONNECT_TIMEOUT");
      })).rejects.toThrow("CONNECT_TIMEOUT");
      expect(attempts).toBe(2);
    });
  });

  test("never replays a failure that could have already applied a write", async () => {
    // CONNECTION_CLOSED / ECONNRESET can land after the statement reached the server,
    // so a retry could re-run an INSERT or UPDATE. These must surface on attempt one.
    for (const code of ["CONNECTION_CLOSED", "ECONNRESET", "CONNECTION_DESTROYED"]) {
      await withStubbedPool(async (svc) => {
        let attempts = 0;
        await expect(svc.withConnection("postgres://x", async () => {
          attempts++;
          throw err(code);
        })).rejects.toThrow(code);
        expect(attempts).toBe(1);
      });
    }
  });

  test("does not replay an ordinary SQL error", async () => {
    await withStubbedPool(async (svc) => {
      let attempts = 0;
      await expect(svc.withConnection("postgres://x", async () => {
        attempts++;
        throw Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" });
      })).rejects.toThrow("does not exist");
      expect(attempts).toBe(1);
    });
  });

  test("passes a successful operation straight through", async () => {
    await withStubbedPool(async (svc, state) => {
      let attempts = 0;
      const result = await svc.withConnection("postgres://x", async () => {
        attempts++;
        return 42;
      });
      expect(attempts).toBe(1);
      expect(result).toBe(42);
      expect(state.disconnects).toBe(0);
    });
  });
});
