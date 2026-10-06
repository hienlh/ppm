/**
 * What the Save changes dialog works out from the server's preview, and what it says about the
 * outcome: the cascade ticks, the script in the order the server runs it, the referencing tables'
 * names, the toast, and the per-device Don't ask again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  cascadeTables, gridSaveAsks, refKey, refLabel, refPaths, savedText, saveScript, stopAskingGridSave,
} from "../../../src/web/components/database/grid/grid-save-model.ts";
import type { ChangesetReference } from "../../../src/shared/db-changeset";

const ref = (table: string, schema: string | null, script: string): ChangesetReference =>
  ({ schema, table, paths: [[table, "users"]], cascadesInDb: false, script });
const ITEMS = ref("order_items", "public", "DELETE items;");
const ORDERS = ref("orders", "public", "DELETE orders;");
const AUDIT = ref("orders", "audit", "DELETE audit orders;");
const preview = { script: "DELETE users;", references: [ITEMS, ORDERS, AUDIT] };

describe("the cascade", () => {
  it("is nothing until Delete references CASCADE is ticked, then every table but the unticked, in the preview's order", () => {
    expect(cascadeTables(preview, false, new Set())).toEqual([]);
    expect(cascadeTables(preview, true, new Set())).toEqual([ITEMS, ORDERS, AUDIT]);
    // Two schemas each hold an `orders`: unticking one leaves the other.
    expect(cascadeTables(preview, true, new Set([refKey(ORDERS)]))).toEqual([ITEMS, AUDIT]);
    expect(refKey(ORDERS)).not.toBe(refKey(AUDIT));
    expect(refKey(ref("t", null, ""))).toBe(".t");
  });

  it("puts the ticked tables' DELETEs before the changes, and leaves out a part with nothing in it", () => {
    expect(saveScript(preview, [ITEMS, ORDERS])).toBe("DELETE items;\nDELETE orders;\nDELETE users;");
    expect(saveScript(preview, [])).toBe("DELETE users;");
    expect(saveScript({ script: "" }, [ITEMS])).toBe("DELETE items;");
    expect(saveScript({ script: "DELETE users;" }, [ref("x", null, "")])).toBe("DELETE users;");
  });
});

describe("the tables listed", () => {
  it("name their schema only when it is not the saved table's", () => {
    expect(refLabel(ORDERS, "public")).toBe("orders");
    expect(refLabel(AUDIT, "public")).toBe("audit.orders");
    expect(refLabel(ref("t", null, ""), "public")).toBe("t");
    expect(refLabel(ORDERS, null)).toBe("public.orders");
  });

  it("say each way they reach the rows deleted", () => {
    expect(refPaths({ paths: [["order_items", "orders", "users"], ["order_items", "users"]] }))
      .toEqual(["order_items → orders → users", "order_items → users"]);
  });
});

describe("what the dialog says", () => {
  it("counts every row written, cascaded ones too", () => {
    expect(savedText({ inserted: 1, updated: 2, deleted: 3, cascaded: 4, executionTimeMs: 7 })).toBe("10 changes saved in one transaction · 7 ms");
    expect(savedText({ inserted: 0, updated: 0, deleted: 0, cascaded: 1, executionTimeMs: 0 })).toBe("1 change saved in one transaction · 0 ms");
  });
});

describe("Don't ask again", () => {
  const realStorage = globalThis.localStorage;
  const storage = (over: Partial<Storage>) => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), ...over },
    });
  };
  afterEach(() => { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: realStorage }); });

  it("asks until told not to, on this device", () => {
    storage({});
    expect(gridSaveAsks()).toBe(true);
    stopAskingGridSave();
    expect(gridSaveAsks()).toBe(false);
  });

  it("keeps asking where the browser keeps nothing", () => {
    storage({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(() => stopAskingGridSave()).not.toThrow();
    expect(gridSaveAsks()).toBe(true);
  });
});
