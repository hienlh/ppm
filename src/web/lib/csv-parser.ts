/** Simple state-machine CSV parser handling quoted fields, embedded commas, newlines */

const enum State {
  FIELD_START,
  UNQUOTED,
  QUOTED,
  QUOTE_IN_QUOTED,
}

export interface CsvData {
  headers: string[];
  rows: string[][];
}

export function parseCsv(content: string): CsvData {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: State = State.FIELD_START;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    switch (state) {
      case State.FIELD_START:
        if (ch === '"') {
          state = State.QUOTED;
        } else if (ch === ",") {
          row.push(field);
          field = "";
        } else if (ch === "\r") {
          // skip \r, handle \n next
        } else if (ch === "\n") {
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
        } else {
          field += ch;
          state = State.UNQUOTED;
        }
        break;

      case State.UNQUOTED:
        if (ch === ",") {
          row.push(field);
          field = "";
          state = State.FIELD_START;
        } else if (ch === "\r") {
          // skip
        } else if (ch === "\n") {
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
          state = State.FIELD_START;
        } else {
          field += ch;
        }
        break;

      case State.QUOTED:
        if (ch === '"') {
          state = State.QUOTE_IN_QUOTED;
        } else {
          field += ch;
        }
        break;

      case State.QUOTE_IN_QUOTED:
        if (ch === '"') {
          // Escaped quote ""
          field += '"';
          state = State.QUOTED;
        } else if (ch === ",") {
          row.push(field);
          field = "";
          state = State.FIELD_START;
        } else if (ch === "\r") {
          // skip
        } else if (ch === "\n") {
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
          state = State.FIELD_START;
        } else {
          // Malformed — treat closing quote as literal
          field += ch;
          state = State.UNQUOTED;
        }
        break;
    }
  }

  // Flush last field/row
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0]!;
  const dataRows = rows.slice(1);

  // Normalize column count — pad short rows, truncate long ones
  const colCount = headers.length;
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]!;
    if (r.length < colCount) {
      while (r.length < colCount) r.push("");
    } else if (r.length > colCount) {
      dataRows[i] = r.slice(0, colCount);
    }
  }

  return { headers, rows: dataRows };
}

export function serializeCsv(headers: string[], rows: string[][]): string {
  const escape = (val: string): string => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\n");
}
