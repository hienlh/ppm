/**
 * Advanced: which databases the tree lists, the isolation level PPM's own transactions use, and how
 * long a Query tab statement may run. Only a server has it; a SQLite file is one database, and a
 * statement on it cannot be stopped.
 */
import { DEFAULT_ISOLATION, ISOLATION_LEVELS, type IsolationLevel } from "../../../../shared/db-connection-config";
import type { ServerDbType } from "../../../../shared/db-connection-url";
import { cn } from "@/lib/utils";
import { Field, SelectInput, TextInput, inputClass } from "./form-controls";
import { enterConnects } from "./connection-general-pane";
import type { ConnectionForm } from "./use-connection-form";

export function ConnectionAdvancedPane({ form }: { form: ConnectionForm }) {
  const { values, update, problem, register } = form;
  const type = values.type as ServerDbType;
  const errorOf = (field: "allowedDatabases" | "allowedDatabasesRegex" | "isolationLevel" | "queryTimeoutSec") => (
    problem?.field === field ? problem.message : null
  );

  return (
    <div className="grid content-start gap-4 md:gap-[18px]">
      <Field label="Allowed databases" htmlFor="cf-allowed" error={errorOf("allowedDatabases")} help="The tree lists only these. Empty: every database the user can see.">
        <textarea
          id="cf-allowed"
          ref={register("allowedDatabases")}
          rows={4}
          value={values.allowedDatabases}
          onChange={(e) => update({ allowedDatabases: e.target.value })}
          placeholder="One database per line"
          spellCheck={false}
          autoCapitalize="off"
          className={cn(inputClass, "h-auto md:h-auto py-2 font-mono resize-y leading-normal")}
        />
      </Field>
      <Field label="Allowed databases regular expression" htmlFor="cf-allowed-re" error={errorOf("allowedDatabasesRegex")}>
        <TextInput
          id="cf-allowed-re"
          ref={register("allowedDatabasesRegex")}
          mono
          value={values.allowedDatabasesRegex}
          invalid={!!errorOf("allowedDatabasesRegex")}
          onChange={(e) => update({ allowedDatabasesRegex: e.target.value })}
          onKeyDown={enterConnects(form)}
          placeholder="^shop"
        />
      </Field>
      <Field
        label="Default isolation level"
        htmlFor="cf-isolation"
        error={errorOf("isolationLevel")}
        help="The transaction Save runs your changes in."
      >
        <SelectInput
          id="cf-isolation"
          ref={register("isolationLevel")}
          value={values.isolationLevel}
          onChange={(e) => update({ isolationLevel: e.target.value as IsolationLevel | "" })}
        >
          <option value="">Server default ({DEFAULT_ISOLATION[type]})</option>
          {ISOLATION_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </SelectInput>
      </Field>
      <Field
        label="Query timeout (seconds)"
        htmlFor="cf-query-timeout"
        error={errorOf("queryTimeoutSec")}
        help="A statement the Query tab runs is stopped after this long. Empty: no limit."
      >
        <TextInput
          id="cf-query-timeout"
          ref={register("queryTimeoutSec")}
          inputMode="numeric"
          value={values.queryTimeoutSec}
          invalid={!!errorOf("queryTimeoutSec")}
          onChange={(e) => update({ queryTimeoutSec: e.target.value })}
          onKeyDown={enterConnects(form)}
          placeholder="No limit"
        />
      </Field>
    </div>
  );
}
