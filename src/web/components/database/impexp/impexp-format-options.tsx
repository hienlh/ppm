/**
 * The options of a storage type, under its box as DBGate lists them, with DBGate's labels: how the
 * files of an export are written, Export to ZIP file, and how the files of an import are read.
 * One set serves the whole run. The delimiters are picked by their place in the list, since a
 * `<select>` is no place to round-trip a Tab or a line break through.
 */
import { useId } from "react";
import {
  CSV_BOOLEAN_FORMATS, CSV_DELIMITERS, CSV_RECORD_DELIMITERS,
  type ExportFormatOptions, type ImpExpFileFormat, type ImportFileFormat, type ImportFormatOptions, type JsonOptions,
} from "../../../../shared/db-impexp";
import { Field, SelectInput, TextInput } from "../connection-form/form-controls";
import { CheckField } from "./impexp-parts";

/** A select over `list`, by index. */
function ListSelect<T>({ id, list, value, onChange }: {
  id: string;
  list: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const at = list.findIndex((x) => x.value === value);
  return (
    <SelectInput id={id} value={String(Math.max(at, 0))} onChange={(e) => onChange(list[Number(e.target.value)]!.value)}>
      {list.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
    </SelectInput>
  );
}

const JSON_STYLES = [{ value: "array", label: "Array" }, { value: "object", label: "Object" }] as const;

function JsonFields({ id, options, onChange }: { id: string; options: JsonOptions; onChange: (o: JsonOptions) => void }) {
  return (
    <>
      <Field label="JSON style" htmlFor={`${id}-style`}>
        <ListSelect id={`${id}-style`} list={JSON_STYLES} value={options.style} onChange={(style) => onChange({ ...options, style })} />
      </Field>
      <Field label={'Key field (only for "Object" style)'} htmlFor={`${id}-key`}>
        <TextInput id={`${id}-key`} value={options.keyField} placeholder="_key" onChange={(e) => onChange({ ...options, keyField: e.target.value })} />
      </Field>
      <Field label="Root field" htmlFor={`${id}-root`}>
        <TextInput id={`${id}-root`} value={options.rootField} onChange={(e) => onChange({ ...options, rootField: e.target.value })} />
      </Field>
    </>
  );
}

/** How an export's files are written, then Export to ZIP file. */
export function ExportFormatFields({ format, options, onChange, zip, zipName, onZip }: {
  format: ImpExpFileFormat;
  options: ExportFormatOptions;
  onChange: (options: ExportFormatOptions) => void;
  zip: boolean;
  zipName: string;
  onZip: (zip: boolean, zipName: string) => void;
}) {
  const id = useId();
  const csv = options.csv;
  const setCsv = (change: Partial<ExportFormatOptions["csv"]>) => onChange({ ...options, csv: { ...csv, ...change } });
  return (
    <>
      {format === "csv" && (
        <>
          <Field label="Delimiter" htmlFor={`${id}-delimiter`}>
            <ListSelect id={`${id}-delimiter`} list={CSV_DELIMITERS} value={csv.delimiter} onChange={(delimiter) => setCsv({ delimiter })} />
          </Field>
          <CheckField label="Quoted" checked={csv.quoted} onChange={(quoted) => setCsv({ quoted })} />
          <CheckField label="Has header row" checked={csv.header} onChange={(header) => setCsv({ header })} />
          <CheckField label="Write BOM (Byte Order Mark)" checked={csv.bom} onChange={(bom) => setCsv({ bom })} />
          <Field label="Record Delimiter" htmlFor={`${id}-record`}>
            <ListSelect id={`${id}-record`} list={CSV_RECORD_DELIMITERS} value={csv.recordDelimiter} onChange={(recordDelimiter) => setCsv({ recordDelimiter })} />
          </Field>
          <Field label="Boolean Format" htmlFor={`${id}-boolean`}>
            <ListSelect id={`${id}-boolean`} list={CSV_BOOLEAN_FORMATS} value={csv.booleanFormat} onChange={(booleanFormat) => setCsv({ booleanFormat })} />
          </Field>
        </>
      )}
      {format === "json" && <JsonFields id={id} options={options.json} onChange={(json) => onChange({ ...options, json })} />}
      {format === "xml" && (
        <>
          <Field label="Root element name" htmlFor={`${id}-xml-root`}>
            <TextInput id={`${id}-xml-root`} value={options.xml.rootElement} placeholder="root" onChange={(e) => onChange({ ...options, xml: { ...options.xml, rootElement: e.target.value } })} />
          </Field>
          <Field label="Item element name" htmlFor={`${id}-xml-item`}>
            <TextInput id={`${id}-xml-item`} value={options.xml.itemElement} placeholder="row" onChange={(e) => onChange({ ...options, xml: { ...options.xml, itemElement: e.target.value } })} />
          </Field>
        </>
      )}
      {format === "xlsx" && (
        <CheckField label="Create single file" checked={options.xlsxSingleFile} onChange={(xlsxSingleFile) => onChange({ ...options, xlsxSingleFile })} />
      )}
      <CheckField label="Export to ZIP file" checked={zip} onChange={(on) => onZip(on, zipName)} />
      {zip && (
        <Field label="Output ZIP archive" htmlFor={`${id}-zip`}>
          <TextInput id={`${id}-zip`} value={zipName} placeholder="zip-archive-yyyy-mm-dd-hh-mm-ss.zip" onChange={(e) => onZip(true, e.target.value)} />
        </Field>
      )}
    </>
  );
}

const IMPORT_DELIMITERS: readonly { value: ImportFormatOptions["csv"]["delimiter"]; label: string }[] = [
  { value: "", label: "Auto-detect" },
  ...CSV_DELIMITERS,
];

/** How an import's files are read. */
export function ImportFormatFields({ format, options, onChange }: {
  format: ImportFileFormat;
  options: ImportFormatOptions;
  onChange: (options: ImportFormatOptions) => void;
}) {
  const id = useId();
  if (format === "csv") {
    const csv = options.csv;
    return (
      <>
        <Field label="Delimiter" htmlFor={`${id}-delimiter`}>
          <ListSelect id={`${id}-delimiter`} list={IMPORT_DELIMITERS} value={csv.delimiter} onChange={(delimiter) => onChange({ ...options, csv: { ...csv, delimiter } })} />
        </Field>
        <CheckField label="Has header row" checked={csv.header} onChange={(header) => onChange({ ...options, csv: { ...csv, header } })} />
      </>
    );
  }
  if (format === "json") return <JsonFields id={id} options={options.json} onChange={(json) => onChange({ ...options, json })} />;
  return null;
}
