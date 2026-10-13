import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
import { selfCommitNote, type DbExecuteApprovalInput } from "../../../src/shared/db-ai-tools";
installDom();
afterAll(uninstallDom);
const { DbExecuteApprovalCard } = await import("../../../src/web/components/chat/db-execute-approval-card");

const input = (dbType: DbExecuteApprovalInput["dbType"], sql: string): DbExecuteApprovalInput => ({
  connectionId: 1, connectionName: "Prod", dbType, group: null, color: null, readonly: false, sql, reason: "Add a column", passwordRequired: true,
});

describe("selfCommitNote", () => {
  it("names the last statement MySQL or MariaDB commits by itself, and what goes with it", () => {
    expect(selfCommitNote("mysql", "UPDATE a SET b = 1;\nALTER TABLE a ADD c INT;\nUPDATE a SET c = 1"))
      .toBe("MySQL commits the ALTER in statement 2 by itself, together with everything before it, so statements 1–2 cannot be rolled back.");
    expect(selfCommitNote("mariadb", "CREATE TABLE a (id INT);\n-- then\n/* fill it */ truncate b;\nINSERT INTO a VALUES (1)"))
      .toBe("MariaDB commits the TRUNCATE in statement 2 by itself, together with everything before it, so statements 1–2 cannot be rolled back.");
    expect(selfCommitNote("mysql", "DROP TABLE a;\nINSERT INTO b VALUES (1)")).toBe("MySQL commits the DROP in statement 1 by itself, so it cannot be rolled back.");
    expect(selfCommitNote("mysql", "ALTER TABLE a ADD c INT")).toBe("MySQL commits the ALTER by itself, so it cannot be rolled back.");
  });

  it("says nothing for a script with none, a TEMPORARY table, or a database that rolls DDL back", () => {
    expect(selfCommitNote("mysql", "UPDATE a SET b = 1;\nDELETE FROM a WHERE id = 2")).toBeNull();
    expect(selfCommitNote("mariadb", "CREATE TEMPORARY TABLE t (id INT);\nDROP TEMPORARY TABLE t;\nUPDATE a SET created = 'CREATE'")).toBeNull();
    expect(selfCommitNote("postgres", "ALTER TABLE a ADD c INT")).toBeNull();
    expect(selfCommitNote("sqlite", "CREATE TABLE a (id INT)")).toBeNull();
  });
});

describe("DbExecuteApprovalCard", () => {
  it("tells the user before they approve which part a MySQL script cannot roll back", async () => {
    const sql = "UPDATE a SET b = 1;\nALTER TABLE a ADD c INT";
    const mysql = await mount(<DbExecuteApprovalCard requestId="r1" input={input("mysql", sql)} />);
    try {
      expect(mysql.container.textContent).toContain("Runs once, in one transaction.");
      expect(mysql.container.textContent).toContain("MySQL commits the ALTER in statement 2 by itself, together with everything before it, so statements 1–2 cannot be rolled back.");
    } finally { await mysql.unmount(); }
    const postgres = await mount(<DbExecuteApprovalCard requestId="r2" input={input("postgres", sql)} />);
    try {
      expect(postgres.container.textContent).toContain("Runs once, in one transaction.");
      expect(postgres.container.textContent).not.toContain("cannot be rolled back");
    } finally { await postgres.unmount(); }
  });
});
