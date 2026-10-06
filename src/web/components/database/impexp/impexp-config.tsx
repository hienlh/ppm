/**
 * DBGate's two configuration columns, Source and Target, with the arrow between them. Each has
 * its Storage type and what that type needs: a database's Server, Database and Schema boxes, the
 * tables or views to export, a query's SQL, the files to import, and the format's options. The
 * database is one, shown on whichever side it is: the source of an export, the target of an import.
 */
import { useId, useMemo } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine } from "@/lib/icons";
import type { ImportUpload } from "../../../../shared/db-impexp";
import { Field, SelectInput } from "../connection-form/form-controls";
import { SqlQueryEditor } from "../sql-query-editor";
import { useSqlSchemaInfo } from "../query/use-sql-schema-info";
import {
  SOURCE_TYPE_OPTIONS, addTables, isFileSource, setDatabase, setSourceType, setTables, setTargetType, targetTypeOptions,
  type ImpExpDatabase, type ImpExpForm, type ImpExpSourceType, type ImpExpTargetType,
} from "./impexp-state";
import type { ImpExpDbContext } from "./use-impexp-database";
import { CurrentDbButton, DatabaseFields } from "./impexp-database-fields";
import { ExportFormatFields, ImportFormatFields } from "./impexp-format-options";
import { FileInput } from "./impexp-file-input";
import { TablesSelect } from "./impexp-tables-select";
import { ConfigTitle } from "./impexp-parts";

type FormChange = (change: (form: ImpExpForm) => ImpExpForm) => void;

export function ImpExpConfig({ form, ctx, onForm, onUploaded }: {
  form: ImpExpForm;
  ctx: ImpExpDbContext;
  onForm: FormChange;
  onUploaded: (upload: ImportUpload) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-1 px-2">
      <SourceConfig form={form} ctx={ctx} onForm={onForm} onUploaded={onUploaded} />
      <ArrowRight aria-hidden className="size-8 self-center text-primary" />
      <TargetConfig form={form} ctx={ctx} onForm={onForm} />
    </div>
  );
}

function SourceConfig({ form, ctx, onForm, onUploaded }: {
  form: ImpExpForm;
  ctx: ImpExpDbContext;
  onForm: FormChange;
  onUploaded: (upload: ImportUpload) => void;
}) {
  const id = useId();
  const type = form.sourceType;
  const fromDb = type === "database" || type === "query";
  const pickDb = (db: ImpExpDatabase) => onForm((f) => setDatabase(f, db));
  return (
    <section aria-label="Source configuration" className="min-w-0 p-2">
      <ConfigTitle icon={ArrowDownToLine}>Source configuration</ConfigTitle>
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <CurrentDbButton importing={false} onPick={(db) => onForm((f) => setDatabase(setSourceType(f, "database"), db))} />
        </div>
        <Field label="Storage type" htmlFor={`${id}-type`}>
          <SelectInput id={`${id}-type`} value={type} onChange={(e) => onForm((f) => setSourceType(f, e.target.value as ImpExpSourceType))}>
            {SOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </SelectInput>
        </Field>
        {fromDb && <DatabaseFields db={form.db} ctx={ctx} importing={false} showSchema={type === "database"} onChange={pickDb} />}
        {type === "database" && form.db.target && (
          <TablesSelect
            relations={ctx.relations} value={form.rows.map((r) => r.source)} loading={ctx.objects.loading}
            onChange={(names) => onForm((f) => setTables(f, names))}
            onAdd={(names) => onForm((f) => addTables(f, names))}
          />
        )}
        {type === "query" && <QueryField form={form} ctx={ctx} onForm={onForm} />}
        {isFileSource(type) && (
          <>
            <FileInput onUploaded={onUploaded} />
            <ImportFormatFields format={type} options={form.importOptions} onChange={(importOptions) => onForm((f) => ({ ...f, importOptions }))} />
          </>
        )}
      </div>
    </section>
  );
}

/** A Query source's SQL, in a small editor as DBGate's; what the grid ran when it was opened from one. */
function QueryField({ form, ctx, onForm }: { form: ImpExpForm; ctx: ImpExpDbContext; onForm: FormChange }) {
  const schemaInfo = useSqlSchemaInfo(ctx.target);
  // Read once: the editor keeps its own text from then on, and tells the form what it is.
  const initial = useMemo(() => form.sql, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid min-w-0 gap-[5px]">
      <span className="text-xs font-medium text-text-2">Query</span>
      <div className="h-[140px] min-w-0 overflow-hidden rounded-md border border-border">
        <SqlQueryEditor
          onExecute={() => {}} loading={false} defaultValue={initial} persistedSql={initial}
          onSqlChange={(sql) => onForm((f) => (f.sql === sql ? f : { ...f, sql }))}
          schemaInfo={schemaInfo} dialect={ctx.dialect}
        />
      </div>
    </div>
  );
}

function TargetConfig({ form, ctx, onForm }: { form: ImpExpForm; ctx: ImpExpDbContext; onForm: FormChange }) {
  const id = useId();
  const importing = isFileSource(form.sourceType);
  const type = form.targetType;
  return (
    <section aria-label="Target configuration" className="min-w-0 p-2">
      <ConfigTitle icon={ArrowUpFromLine}>Target configuration</ConfigTitle>
      <div className="grid gap-3">
        {importing && (
          <div className="flex flex-wrap gap-1.5 empty:hidden">
            <CurrentDbButton importing onPick={(db) => onForm((f) => setDatabase(f, db))} />
          </div>
        )}
        <Field label="Storage type" htmlFor={`${id}-type`}>
          <SelectInput id={`${id}-type`} value={type} onChange={(e) => onForm((f) => setTargetType(f, e.target.value as ImpExpTargetType))}>
            {targetTypeOptions(form.sourceType).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </SelectInput>
        </Field>
        {type === "database" ? (
          <DatabaseFields db={form.db} ctx={ctx} importing showSchema onChange={(db) => onForm((f) => setDatabase(f, db))} />
        ) : (
          <ExportFormatFields
            format={type} options={form.exportOptions} onChange={(exportOptions) => onForm((f) => ({ ...f, exportOptions }))}
            zip={form.zip} zipName={form.zipName} onZip={(zip, zipName) => onForm((f) => ({ ...f, zip, zipName }))}
          />
        )}
      </div>
    </section>
  );
}
