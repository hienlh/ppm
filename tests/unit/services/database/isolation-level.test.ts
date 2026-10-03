/**
 * The Default isolation level reaches Save's transaction as SQL, where no parameter can carry it,
 * so it is checked against the four the standard names before anything is sent: a config can
 * reach `ppm.db` through an import as well as through the form.
 *
 * The services are driven with a recording stand-in for the connection;
 * `tests/integration/database-connection-settings.test.ts` reads the level back from real servers.
 */
import { describe, expect, it } from "bun:test";
import { isolationLevelSql } from "../../../../src/services/database/isolation-level.ts";
import { mysqlService } from "../../../../src/services/mysql.service.ts";
import { postgresService } from "../../../../src/services/postgres.service.ts";
import type { ChangesetStatement } from "../../../../src/types/database.ts";

const INSERT: ChangesetStatement = {
  sql: "INSERT INTO t (id) VALUES (?)", params: [1], displaySql: "INSERT INTO t (id) VALUES (1)", kind: "insert", expectOne: true,
};
const HOSTILE = "SERIALIZABLE; DROP TABLE users";

describe("isolationLevelSql", () => {
  it("takes the four standard levels in any case, and nothing for none", () => {
    expect(["read uncommitted", "Read Committed", "REPEATABLE READ", "serializable"].map(isolationLevelSql))
      .toEqual(["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]);
    expect([undefined, null, ""].map(isolationLevelSql)).toEqual([null, null, null]);
  });

  it("refuses anything else rather than writing it into a statement", () => {
    for (const bad of [HOSTILE, "SNAPSHOT", " serializable", 1, {}]) {
      expect(() => isolationLevelSql(bad)).toThrow(/Unknown isolation level/);
    }
  });
});

/** The MySQL service, with a pool that hands out a connection recording what it is sent. */
function recordingMysql() {
  const sent: string[] = [];
  let acquired = 0;
  const conn = {
    async query(sql: string) { sent.push(sql); return [{}]; },
    async execute(options: { sql: string }) { sent.push(options.sql); return [{ affectedRows: 1 }]; },
    release() {},
    destroy() {},
  };
  const service = Object.create(mysqlService) as typeof mysqlService;
  (service as unknown as { acquire(): Promise<unknown> }).acquire = async () => { acquired++; return conn; };
  return { service, sent, acquired: () => acquired };
}

describe("MySQL and MariaDB Save", () => {
  it("sets the level for the next transaction only, right before starting it", async () => {
    const { service, sent } = recordingMysql();
    await service.applyChangeset("mysql://h/db", [INSERT], "serializable");
    // No SESSION: the pooled connection must be back at the server's own level afterwards.
    expect(sent).toEqual(["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "START TRANSACTION", INSERT.sql, "COMMIT"]);
  });

  it("leaves the server's own level alone when the connection names none", async () => {
    const { service, sent } = recordingMysql();
    await service.applyChangeset("mysql://h/db", [INSERT], undefined);
    expect(sent).toEqual(["START TRANSACTION", INSERT.sql, "COMMIT"]);
  });

  it("refuses an unknown level before taking a connection", async () => {
    const { service, sent, acquired } = recordingMysql();
    await expect(service.applyChangeset("mysql://h/db", [INSERT], HOSTILE)).rejects.toThrow(/Unknown isolation level/);
    expect({ sent, acquired: acquired() }).toEqual({ sent: [], acquired: 0 });
  });
});

/** The Postgres service, with a client that records how each transaction was begun. */
function recordingPostgres() {
  const begun: string[] = [];
  let connected = 0;
  type Body = (tx: unknown) => Promise<unknown>;
  const tx = { unsafe: async () => ({ count: 1 }) };
  const sql = {
    begin(modeOrBody: string | Body, body?: Body) {
      begun.push(typeof modeOrBody === "string" ? modeOrBody : "(no mode)");
      return (body ?? (modeOrBody as Body))(tx);
    },
  };
  const service = Object.create(postgresService) as typeof postgresService;
  (service as unknown as { withConnection(cs: string, fn: (sql: unknown) => Promise<unknown>): Promise<unknown> })
    .withConnection = async (_cs, fn) => { connected++; return fn(sql); };
  return { service, begun, connected: () => connected };
}

describe("Postgres Save", () => {
  it("begins the transaction at the connection's level", async () => {
    const { service, begun } = recordingPostgres();
    expect(await service.applyChangeset("postgres://h/db", [INSERT], "Repeatable Read")).toEqual([1]);
    expect(begun).toEqual(["isolation level repeatable read"]);
  });

  it("begins it with no mode when the connection names none", async () => {
    const { service, begun } = recordingPostgres();
    await service.applyChangeset("postgres://h/db", [INSERT]);
    expect(begun).toEqual(["(no mode)"]);
  });

  it("refuses an unknown level before opening a connection", async () => {
    const { service, begun, connected } = recordingPostgres();
    await expect(service.applyChangeset("postgres://h/db", [INSERT], HOSTILE)).rejects.toThrow(/Unknown isolation level/);
    expect({ begun, connected: connected() }).toEqual({ begun: [], connected: 0 });
  });
});
